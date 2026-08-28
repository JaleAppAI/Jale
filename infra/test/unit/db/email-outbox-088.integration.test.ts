/**
 * email-outbox-088.integration.test.ts
 *
 * PostgreSQL-backed suite for migration 088 (email_outbox delivery metadata +
 * public.disable_digest_for_employer).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the
 * full migration chain (001->088) applied, connected as a superuser (e.g.
 * `postgres`) so this suite can set role passwords and arrange fixtures that
 * FORCE ROW LEVEL SECURITY would otherwise block. When absent every test here
 * is skipped LOUDLY -- same contract as digest-settings.integration.test.ts.
 *
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests \
 *        --ref none --port 55493 --container jale-s22-r3 --repo .
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55493/jale \
 *        npx jest --runInBand test/unit/db/email-outbox-088
 *
 * Superuser writes arrange state; every claim about who may see or change what
 * is made over a real non-superuser jale_admin connection, because a superuser
 * is not subject to RLS and would make each of those claims vacuous.
 */

import { Client } from 'pg';
import { DIGEST_SETTINGS_UPSERT_SQL } from '../../../lambda/api/employer-digest-settings';
import { MAX_EMAIL_SEND_ATTEMPTS } from '../../../lambda/lib/email-outbox';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
  } finally {
    await client.end();
  }
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[email-outbox-088.integration] SKIPPED: "${name}" -- set JALE_TEST_DATABASE_URL to run `
        + 'PostgreSQL-backed tests. This is a DONE_WITH_CONCERNS gate: Docker/Postgres was '
        + 'unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const SUB_BOUNCED = 'outbox-088-employer-bounced';
const SUB_OFF = 'outbox-088-employer-off';
const ALL_SUBS = [SUB_BOUNCED, SUB_OFF];
const EMAIL_LIKE = 'outbox-088-%@example.test';

let superuserUrl: string;
let adminUrl: string;
const userIds = new Map<string, string>();

/** See digest-settings.integration.test.ts: a silent seeding failure would turn every negative probe green. */
function idOf(sub: string): string {
  const id = userIds.get(sub);
  if (!id) throw new Error(`fixture user id missing for ${sub} -- beforeAll seeding did not complete`);
  return id;
}

async function insertOutbox(
  client: Client,
  overrides: Partial<{
    recipientEmail: string;
    sourceType: string;
    sourceId: string;
    sesMessageId: string | null;
    headers: string | null;
  }> = {},
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO email_outbox
       (recipient_email, subject, body_text, source_type, source_id, ses_message_id, headers)
     VALUES ($1, 'Subject', 'Body', $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      overrides.recipientEmail ?? 'outbox-088-a@example.test',
      overrides.sourceType ?? 'employer_digest',
      overrides.sourceId ?? idOf(SUB_BOUNCED),
      overrides.sesMessageId ?? null,
      overrides.headers ?? null,
    ],
  );
  return inserted.rows[0].id;
}

async function resetFixtures(): Promise<void> {
  await withClient(superuserUrl, async (client) => {
    await client.query(`DELETE FROM email_outbox WHERE recipient_email LIKE $1`, [EMAIL_LIKE]);
    await client.query(
      `UPDATE employer_digest_settings s
          SET enabled = true, unsubscribe_token_version = 1
         FROM users u
        WHERE u.id = s.employer_id AND u.cognito_sub = $1`,
      [SUB_BOUNCED],
    );
    await client.query(
      `UPDATE employer_digest_settings s
          SET enabled = false, unsubscribe_token_version = 1
         FROM users u
        WHERE u.id = s.employer_id AND u.cognito_sub = $1`,
      [SUB_OFF],
    );
  });
}

maybeDescribe('email_outbox delivery metadata + digest feedback definer (migration 088)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    superuserUrl = databaseUrl;
    await setServiceRolePasswords(superuserUrl);
    adminUrl = new URL(databaseUrl).username === 'jale_admin'
      ? databaseUrl
      : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');

    await withClient(superuserUrl, async (client) => {
      await client.query(`DELETE FROM email_outbox WHERE recipient_email LIKE $1`, [EMAIL_LIKE]);
      await client.query(
        `DELETE FROM employer_digest_settings
          WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
        [ALL_SUBS],
      );
      await client.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [ALL_SUBS]);

      for (const sub of ALL_SUBS) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, email, phone, full_name, created_at, updated_at)
           VALUES ($1, 'employer', $2, '+15550000000', 'Outbox 088 Fixture', NOW(), NOW())
           RETURNING id`,
          [sub, `${sub}@example.test`],
        );
        userIds.set(sub, inserted.rows[0].id);
      }
      for (const sub of ALL_SUBS) {
        await client.query(
          `INSERT INTO employer_digest_settings (employer_id, enabled) VALUES ($1, true)`,
          [idOf(sub)],
        );
      }
    });

    expect(userIds.size).toBe(ALL_SUBS.length);
    for (const sub of ALL_SUBS) expect(typeof userIds.get(sub)).toBe('string');
  }, 60_000);

  beforeEach(async () => {
    if (!databaseUrl) return;
    await resetFixtures();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superuserUrl, async (client) => {
      await client.query(`DELETE FROM email_outbox WHERE recipient_email LIKE $1`, [EMAIL_LIKE]);
      await client.query(
        `DELETE FROM employer_digest_settings
          WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
        [ALL_SUBS],
      );
      await client.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [ALL_SUBS]);
    });
  }, 60_000);

  // ── Schema ────────────────────────────────────────────────────────────────

  it('adds nullable ses_message_id (text) and headers (jsonb) to email_outbox', async () => {
    const columns = await withClient(superuserUrl, (client) =>
      client.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'email_outbox'
            AND column_name IN ('ses_message_id', 'headers')
          ORDER BY column_name`,
      ));
    expect(columns.rows).toEqual([
      { column_name: 'headers', data_type: 'jsonb', is_nullable: 'YES' },
      { column_name: 'ses_message_id', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it('indexes ses_message_id UNIQUE but only where it is set, and indexes the recipient for bounce triage', async () => {
    const indexes = await withClient(superuserUrl, (client) =>
      client.query<{ indexname: string; indexdef: string; indisunique: boolean }>(
        `SELECT c.relname AS indexname, pg_get_indexdef(i.indexrelid) AS indexdef, i.indisunique
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
          WHERE t.relname = 'email_outbox'`,
      ));
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row]));

    const unique = byName.get('email_outbox_ses_message_id_unique');
    expect(unique).toBeDefined();
    expect(unique!.indisunique).toBe(true);
    expect(unique!.indexdef).toContain('WHERE (ses_message_id IS NOT NULL)');

    const recipient = byName.get('email_outbox_recipient_email_idx');
    expect(recipient).toBeDefined();
    expect(recipient!.indexdef).toContain('lower(recipient_email)');
  });

  /**
   * The reconciliation 088's header promises. 037:32 bakes the attempt bound
   * into email_outbox_sweeper_idx as a literal while the claim query in
   * lambda/lib/email-outbox.ts binds MAX_EMAIL_SEND_ATTEMPTS. They agree today
   * (both 5), and 088 deliberately changed NEITHER -- moving either one would
   * change which rows production retries. This test is the enforcement that
   * was missing: edit one side and it goes red.
   */
  it('keeps the sweeper index predicate in step with MAX_EMAIL_SEND_ATTEMPTS', async () => {
    const index = await withClient(superuserUrl, (client) =>
      client.query<{ indexdef: string }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS indexdef
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = 'email_outbox_sweeper_idx'`,
      ));
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain(`attempt_count < ${MAX_EMAIL_SEND_ATTEMPTS}`);
  });

  // ── CHECK constraints ─────────────────────────────────────────────────────

  it('accepts a JSON object (or NULL) in headers and rejects every other JSON type', async () => {
    await withClient(superuserUrl, async (client) => {
      await expect(insertOutbox(client, { headers: null })).resolves.toBeTruthy();
      await expect(insertOutbox(client, { headers: '{}' })).resolves.toBeTruthy();
      await expect(
        insertOutbox(client, { headers: '{"unsubscribe_url":"https://jaleapp.ai/x"}' }),
      ).resolves.toBeTruthy();

      for (const bad of ['[]', '"a string"', '42', 'true', 'null']) {
        await expect(insertOutbox(client, { headers: bad })).rejects.toMatchObject({
          code: '23514',
          constraint: 'email_outbox_headers_object',
        });
      }
    });
  });

  it('rejects an oversized headers blob before it can become an unsendable SMTP header block', async () => {
    await withClient(superuserUrl, async (client) => {
      const big = JSON.stringify({ unsubscribe_url: `https://jaleapp.ai/${'u'.repeat(5000)}` });
      await expect(insertOutbox(client, { headers: big })).rejects.toMatchObject({
        code: '23514',
        constraint: 'email_outbox_headers_object',
      });
    });
  });

  it('lets many rows sit at ses_message_id NULL but refuses a duplicate provider id', async () => {
    await withClient(superuserUrl, async (client) => {
      await insertOutbox(client, { sesMessageId: null });
      await insertOutbox(client, { sesMessageId: null });
      await insertOutbox(client, { sesMessageId: null });

      await insertOutbox(client, { sesMessageId: 'ses-088-unique-1' });
      await expect(insertOutbox(client, { sesMessageId: 'ses-088-unique-1' })).rejects.toMatchObject({
        code: '23505',
      });
      await expect(insertOutbox(client, { sesMessageId: 'ses-088-unique-2' })).resolves.toBeTruthy();
    });
  });

  // ── Grants ────────────────────────────────────────────────────────────────

  it('lets the sweeper role (jale_admin) write the new columns under RLS with no GUC set', async () => {
    const outboxId = await withClient(superuserUrl, (client) =>
      insertOutbox(client, { sesMessageId: null }));

    const updated = await withClient(adminUrl, async (client) => {
      const result = await client.query(
        `UPDATE email_outbox
            SET ses_message_id = $2, headers = $3::jsonb
          WHERE id = $1`,
        [outboxId, 'ses-088-sweeper', '{"unsubscribe_url":"https://jaleapp.ai/u"}'],
      );
      return result.rowCount;
    });
    expect(updated).toBe(1);

    // ...and read it back, which is the bounce handler's lookup path.
    const readBack = await withClient(adminUrl, (client) =>
      client.query<{ source_type: string; source_id: string; recipient_email: string }>(
        `SELECT source_type, source_id, recipient_email
           FROM email_outbox WHERE ses_message_id = $1`,
        ['ses-088-sweeper'],
      ));
    expect(readBack.rows).toHaveLength(1);
    expect(readBack.rows[0].source_type).toBe('employer_digest');
    expect(readBack.rows[0].source_id).toBe(idOf(SUB_BOUNCED));
  });

  // ── disable_digest_for_employer ───────────────────────────────────────────

  /**
   * The whole reason the definer exists. If this ever goes green with the
   * definer deleted, the bounce handler is writing nothing and saying nothing.
   */
  it('fails closed: a bare jale_admin UPDATE with no GUC set changes zero rows and raises nothing', async () => {
    const rowCount = await withClient(adminUrl, async (client) => {
      const result = await client.query(
        `UPDATE employer_digest_settings SET enabled = false WHERE employer_id = $1`,
        [idOf(SUB_BOUNCED)],
      );
      return result.rowCount;
    });
    expect(rowCount).toBe(0);

    const still = await withClient(superuserUrl, (client) =>
      client.query<{ enabled: boolean }>(
        `SELECT enabled FROM employer_digest_settings WHERE employer_id = $1`,
        [idOf(SUB_BOUNCED)],
      ));
    expect(still.rows[0].enabled).toBe(true);
  });

  it('switches the digest off and invalidates every mailed unsubscribe link', async () => {
    const disabled = await withClient(adminUrl, (client) =>
      client.query<{ disabled: number }>(
        `SELECT public.disable_digest_for_employer($1::uuid) AS disabled`,
        [idOf(SUB_BOUNCED)],
      ));
    expect(Number(disabled.rows[0].disabled)).toBe(1);

    const after = await withClient(superuserUrl, (client) =>
      client.query<{ enabled: boolean; unsubscribe_token_version: number }>(
        `SELECT enabled, unsubscribe_token_version
           FROM employer_digest_settings WHERE employer_id = $1`,
        [idOf(SUB_BOUNCED)],
      ));
    expect(after.rows[0].enabled).toBe(false);
    expect(Number(after.rows[0].unsubscribe_token_version)).toBe(2);
  });

  it('is idempotent: a repeated notification reports 0 and does not walk the token version', async () => {
    await withClient(adminUrl, (client) =>
      client.query(`SELECT public.disable_digest_for_employer($1::uuid)`, [idOf(SUB_BOUNCED)]));
    const second = await withClient(adminUrl, (client) =>
      client.query<{ disabled: number }>(
        `SELECT public.disable_digest_for_employer($1::uuid) AS disabled`,
        [idOf(SUB_BOUNCED)],
      ));
    expect(Number(second.rows[0].disabled)).toBe(0);

    const after = await withClient(superuserUrl, (client) =>
      client.query<{ unsubscribe_token_version: number }>(
        `SELECT unsubscribe_token_version FROM employer_digest_settings WHERE employer_id = $1`,
        [idOf(SUB_BOUNCED)],
      ));
    expect(Number(after.rows[0].unsubscribe_token_version)).toBe(2);
  });

  it('reports 0 for an employer who already had the digest off, and for an id that owns no row', async () => {
    const off = await withClient(adminUrl, (client) =>
      client.query<{ disabled: number }>(
        `SELECT public.disable_digest_for_employer($1::uuid) AS disabled`,
        [idOf(SUB_OFF)],
      ));
    expect(Number(off.rows[0].disabled)).toBe(0);

    const unknown = await withClient(adminUrl, (client) =>
      client.query<{ disabled: number }>(
        `SELECT public.disable_digest_for_employer('00000000-0000-4000-8000-000000000000'::uuid) AS disabled`,
      ));
    expect(Number(unknown.rows[0].disabled)).toBe(0);
  });

  it('does not leave its GUC pinned on the caller session', async () => {
    const leaked = await withClient(adminUrl, async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT public.disable_digest_for_employer($1::uuid)`, [idOf(SUB_BOUNCED)]);
      const result = await client.query<{ guc: string | null }>(
        `SELECT current_setting('app.digest_feedback_employer_id', true) AS guc`,
      );
      await client.query('COMMIT');
      return result.rows[0].guc;
    });
    expect(leaked === null || leaked === '').toBe(true);
  });

  it('cannot reach an employer other than the one named, even inside the definer window', async () => {
    await withClient(adminUrl, (client) =>
      client.query(`SELECT public.disable_digest_for_employer($1::uuid)`, [idOf(SUB_BOUNCED)]));

    const bystander = await withClient(superuserUrl, (client) =>
      client.query<{ unsubscribe_token_version: number }>(
        `SELECT unsubscribe_token_version FROM employer_digest_settings WHERE employer_id = $1`,
        [idOf(SUB_OFF)],
      ));
    expect(Number(bystander.rows[0].unsubscribe_token_version)).toBe(1);
  });

  it('keeps the definer off PUBLIC and owned by jale_admin with a pinned search_path', async () => {
    const fn = await withClient(superuserUrl, (client) =>
      client.query<{ owner: string; prosecdef: boolean; proconfig: string[] | null; public_exec: boolean }>(
        `SELECT owner.rolname AS owner, f.prosecdef, f.proconfig,
                EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                ) AS public_exec
           FROM pg_proc f
           JOIN pg_namespace n ON n.oid = f.pronamespace
           JOIN pg_roles owner ON owner.oid = f.proowner
          WHERE n.nspname = 'public' AND f.proname = 'disable_digest_for_employer'`,
      ));
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0].owner).toBe('jale_admin');
    expect(fn.rows[0].prosecdef).toBe(true);
    expect(fn.rows[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(fn.rows[0].public_exec).toBe(false);
  });

  it('never widens jale_digest_enumerator, whose only write stays UPDATE (enabled)', async () => {
    const grants = await withClient(superuserUrl, (client) =>
      client.query<{ column_name: string; privilege_type: string }>(
        `SELECT column_name, privilege_type
           FROM information_schema.column_privileges
          WHERE grantee = 'jale_digest_enumerator'
            AND table_schema = 'public' AND table_name = 'employer_digest_settings'
            AND privilege_type = 'UPDATE'
          ORDER BY column_name`,
      ));
    expect(grants.rows.map((row) => row.column_name)).toEqual(['enabled']);
  });

  // ── unsubscribe_token_version, both writers (E4 + E3) ────────────────────

  /**
   * Runs the STATEMENT THE HANDLER SENDS, as the employer, through the same
   * FORCE-RLS self policy the Lambda sits behind. A mocked assertion on SQL
   * text cannot show that the CASE fires on the right transition, and this
   * column now has two writers -- this upsert and 088's bounce definer -- so
   * the transition semantics are the thing worth pinning.
   */
  async function patchAsEmployer(
    sub: string,
    enabled: boolean | null,
  ): Promise<{ enabled: boolean }> {
    return withClient(adminUrl, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
        const result = await client.query<{ enabled: boolean }>(
          DIGEST_SETTINGS_UPSERT_SQL,
          [idOf(sub), enabled, null, null, null],
        );
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function versionOf(sub: string): Promise<number> {
    const row = await withClient(superuserUrl, (client) =>
      client.query<{ unsubscribe_token_version: number }>(
        `SELECT unsubscribe_token_version FROM employer_digest_settings WHERE employer_id = $1`,
        [idOf(sub)],
      ));
    return Number(row.rows[0].unsubscribe_token_version);
  }

  it('bumps the token version when the employer turns the digest back on', async () => {
    expect(await versionOf(SUB_OFF)).toBe(1);
    const row = await patchAsEmployer(SUB_OFF, true);
    expect(row.enabled).toBe(true);
    expect(await versionOf(SUB_OFF)).toBe(2);
  });

  it('leaves the version alone on every other transition', async () => {
    // already ON -> ON
    expect(await versionOf(SUB_BOUNCED)).toBe(1);
    await patchAsEmployer(SUB_BOUNCED, true);
    expect(await versionOf(SUB_BOUNCED)).toBe(1);

    // ON -> OFF: the old links are already no-ops in effect.
    await patchAsEmployer(SUB_BOUNCED, false);
    expect(await versionOf(SUB_BOUNCED)).toBe(1);

    // a PATCH that does not mention `enabled` at all
    await patchAsEmployer(SUB_OFF, null);
    expect(await versionOf(SUB_OFF)).toBe(1);
  });

  /**
   * The point of the bump, end to end: 082's definer refuses a link minted
   * before it. There is no expiry in the token itself -- BY DESIGN, see
   * lambda/lib/unsubscribe-token.ts -- so this counter is the only thing that
   * can ever revoke one.
   */
  it('makes every previously mailed link a no-op while the current one still works', async () => {
    await patchAsEmployer(SUB_OFF, true);
    expect(await versionOf(SUB_OFF)).toBe(2);

    const stale = await withClient(adminUrl, (client) =>
      client.query<{ unsubscribed: boolean }>(
        `SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS unsubscribed`,
        [idOf(SUB_OFF), 1],
      ));
    expect(stale.rows[0].unsubscribed).toBe(false);
    // Still on: the stale link changed nothing.
    const afterStale = await withClient(superuserUrl, (client) =>
      client.query<{ enabled: boolean }>(
        `SELECT enabled FROM employer_digest_settings WHERE employer_id = $1`, [idOf(SUB_OFF)],
      ));
    expect(afterStale.rows[0].enabled).toBe(true);

    const current = await withClient(adminUrl, (client) =>
      client.query<{ unsubscribed: boolean }>(
        `SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS unsubscribed`,
        [idOf(SUB_OFF), 2],
      ));
    expect(current.rows[0].unsubscribed).toBe(true);
  });

  /** The bounce definer's bump revokes links the same way the re-enable one does. */
  it('lets a bounce revoke the links that were mailed to the dead address', async () => {
    await withClient(adminUrl, (client) =>
      client.query(`SELECT public.disable_digest_for_employer($1::uuid)`, [idOf(SUB_BOUNCED)]));
    expect(await versionOf(SUB_BOUNCED)).toBe(2);

    const stale = await withClient(adminUrl, (client) =>
      client.query<{ unsubscribed: boolean }>(
        `SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS unsubscribed`,
        [idOf(SUB_BOUNCED), 1],
      ));
    expect(stale.rows[0].unsubscribed).toBe(false);
  });
});
