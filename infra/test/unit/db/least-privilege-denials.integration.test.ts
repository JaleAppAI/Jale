/**
 * least-privilege-denials.integration.test.ts -- no runtime login reaches a
 * table the access manifest excludes, whatever it sets.
 *
 * An excluded table is reached only through capability functions or
 * definers. For every runtime login in the merged manifest, every excluded
 * table and every command (SELECT, INSERT, UPDATE, DELETE, TRUNCATE), this
 * suite signs in as the login over a real connection, sets every capability
 * flag the catalog references (each to the value that would open its door
 * for a victim user) plus both identity settings, and runs the command. Each
 * attempt must be refused with 42501, and every excluded table's content must
 * be byte-for-byte unchanged afterwards. An attempt that is not refused is
 * committed, so a missing denial cannot hide behind a rollback. No runtime
 * login may create a temporary table either: 104 revokes TEMPORARY on the
 * database from PUBLIC.
 *
 * The second half covers the tables the logins may write: each write grant
 * lists only the columns its paths write, so a session in a caller's own
 * context still cannot re-point an application at another worker, reach a
 * worker through a conversation it has no application for, choose where an
 * employer message is sent, forge a user's identity or trust columns, or
 * re-address a queued email.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL) for the
 * fixtures and the content checks; the logins sign in through
 * helpers/login-pool.
 */
import { Client } from 'pg';
import { loadManifest, runtimeLogins } from '../../../db/access/access-manifest';
import { capabilityFlags, flagValue, IDENTITY_SETTINGS, type FlagVictim } from './helpers/capability-flags';
import { loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege denials PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-denials] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const manifest = loadManifest();
const logins = runtimeLogins(manifest);
const excludedTables = Object.entries(manifest.tables)
  .filter(([, entry]) => entry.classification === 'excluded')
  .map(([name]) => name)
  .sort();

function quoted(table: string): string {
  return table.split('.').map((part) => `"${part.replace(/"/g, '""')}"`).join('.');
}

/** The five commands, against `table`; `column` is any column of it. */
function attempts(table: string, column: string): Array<[string, string]> {
  const t = quoted(table);
  const c = `"${column.replace(/"/g, '""')}"`;
  return [
    ['SELECT', `SELECT * FROM ${t} LIMIT 1`],
    ['INSERT', `INSERT INTO ${t} DEFAULT VALUES`],
    ['UPDATE', `UPDATE ${t} SET ${c} = ${c}`],
    ['DELETE', `DELETE FROM ${t}`],
    ['TRUNCATE', `TRUNCATE ${t}`],
  ];
}

maybeDescribe('least-privilege denials: excluded tables, every runtime login, every command', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const victimSub = `lp-deny-victim-${stamp}`;
  let victim: FlagVictim;
  /** The excluded tables this bed carries (a runner-managed one may be absent), each with a column an UPDATE may name. */
  const present = new Map<string, string>();

  /** A digest of the table's whole content, read as the superuser. */
  async function digest(table: string): Promise<string> {
    const { rows } = await su.query<{ digest: string }>(
      `SELECT md5(COALESCE(string_agg(t::text, E'\\n' ORDER BY t::text), '')) || ':' || count(*) AS digest FROM ${quoted(table)} t`,
    );
    return rows[0].digest;
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    const victimId = (await su.query<{ id: string }>(
      `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`, [victimSub])).rows[0].id;
    victim = { userId: victimId, sub: victimSub };
    for (const table of excludedTables) {
      const { rows } = await su.query<{ attname: string }>(
        `SELECT a.attname FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attidentity = '' AND a.attgenerated = ''
          ORDER BY a.attnum LIMIT 1`,
        [table],
      );
      if (rows[0]) present.set(table, rows[0].attname);
    }
  });

  afterAll(async () => {
    if (!su) return;
    await su.query('DELETE FROM public.users WHERE cognito_sub = $1', [victimSub]);
    await su.end();
  });

  it('the manifest excludes the upload-token, history and identity-challenge tables', () => {
    expect(excludedTables).toEqual(expect.arrayContaining([
      'public.document_upload_token_slots', 'public.document_upload_tokens', 'public.job_application_status_events',
      'public.subscription_status_history', 'public.worker_identity_challenge_events', 'public.worker_identity_challenges',
    ]));
    // Every excluded table but the runner-managed ledger exists on a migrated bed.
    for (const table of excludedTables) {
      if (manifest.tables[table].runner_managed) continue;
      expect([table, present.has(table)]).toEqual([table, true]);
    }
  });

  it('the flags set below are every capability flag the catalog references', () => {
    expect(capabilityFlags().length).toBeGreaterThan(0);
    for (const flag of capabilityFlags()) expect(flag).toMatch(/^(app|jale)\.[a-z0-9_]+$/);
  });

  it('no runtime login can create a temporary table (42501); the database grants TEMPORARY to nobody but its owner', async () => {
    const outcomes: Array<[string, string | null]> = [];
    for (const login of logins) {
      const client = loginClient(login);
      await client.connect();
      try {
        await client.query(`CREATE TEMP TABLE lp_denials_probe (x integer)`);
        outcomes.push([login, null]);
      } catch (err) {
        outcomes.push([login, (err as { code?: string }).code ?? 'unknown']);
      } finally {
        await client.end();
      }
    }
    expect(outcomes).toEqual(logins.map((login) => [login, '42501']));
  });

  describe.each(logins)('%s', (login) => {
    it('is refused (42501) every command on every excluded table with every flag set, and changes nothing', async () => {
      const before = new Map<string, string>();
      for (const table of present.keys()) before.set(table, await digest(table));

      const settings: Array<[string, string]> = [
        ...capabilityFlags().map((flag): [string, string] => [flag, flagValue(flag, victim)]),
        [IDENTITY_SETTINGS[0], victim.sub],
        [IDENTITY_SETTINGS[1], victim.userId],
      ];
      const outcomes: string[] = [];
      const client = loginClient(login);
      await client.connect();
      try {
        for (const [table, column] of present) {
          for (const [command, sql] of attempts(table, column)) {
            await client.query('BEGIN');
            for (const [name, value] of settings) {
              await client.query('SELECT pg_catalog.set_config($1, $2, true)', [name, value]);
            }
            try {
              await client.query(sql);
              await client.query('COMMIT');
              outcomes.push(`${table} ${command}: ALLOWED`);
            } catch (err) {
              await client.query('ROLLBACK');
              const code = (err as { code?: string }).code;
              if (code !== '42501') outcomes.push(`${table} ${command}: ${code} ${(err as Error).message}`);
            }
          }
        }
      } finally {
        await client.end();
      }
      expect(outcomes).toEqual([]);

      for (const [table, digestBefore] of before) {
        expect([table, await digest(table)]).toEqual([table, digestBefore]);
      }
    });
  });
});

interface Caller { sub?: string; internalUserId?: string }

/** SQLSTATE of `sql` run as `login` in a rolled-back transaction with the caller context set; null when it succeeds. */
async function refusalAs(login: string, caller: Caller, sql: string, params: unknown[] = []): Promise<string | null> {
  return withLoginClient(login, async (client) => {
    await client.query('BEGIN');
    try {
      if (caller.sub !== undefined) await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
      if (caller.internalUserId !== undefined) {
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.internalUserId]);
      }
      await client.query(sql, params);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}

/** Rows of `sql` run as `login` with the caller context set, committed. */
async function rowsAs<T extends object>(login: string, caller: Caller, sql: string, params: unknown[] = []): Promise<T[]> {
  return withLoginClient(login, async (client) => {
    await client.query('BEGIN');
    try {
      if (caller.sub !== undefined) await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
      if (caller.internalUserId !== undefined) {
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.internalUserId]);
      }
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

maybeDescribe('least-privilege denials: writes only to the columns the paths write', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const digits = () => `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const subs = {
    employer: `lp-cw-employer-${stamp}`, other: `lp-cw-other-${stamp}`,
    applicant: `lp-cw-applicant-${stamp}`, victim: `lp-cw-victim-${stamp}`,
  };
  const ids: Record<keyof typeof subs | 'job' | 'otherJob' | 'application' | 'otherApplication' | 'email' | 'event', string> = {
    employer: '', other: '', applicant: '', victim: '', job: '', otherJob: '', application: '', otherApplication: '', email: '', event: '',
  };
  const employer = () => ({ sub: subs.employer, internalUserId: ids.employer });

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    for (const [name, type] of [['employer', 'employer'], ['other', 'employer'], ['applicant', 'worker'], ['victim', 'worker']] as const) {
      ids[name] = (await su.query<{ id: string }>(
        `INSERT INTO public.users (cognito_sub, user_type, email, whatsapp_number, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [subs[name], type, `${name}-${stamp}@example.test`, type === 'worker' ? digits() : null, digits()],
      )).rows[0].id;
    }
    for (const [key, owner] of [['job', 'employer'], ['otherJob', 'other']] as const) {
      ids[key] = (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'Least-privilege column fixture', 'Austin', 'full-time', 'active') RETURNING id`, [ids[owner]],
      )).rows[0].id;
    }
    ids.application = (await su.query<{ id: string }>(
      'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [ids.job, ids.applicant])).rows[0].id;
    // The victim applied only to the other employer's job.
    ids.otherApplication = (await su.query<{ id: string }>(
      'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [ids.otherJob, ids.victim])).rows[0].id;
    ids.email = (await su.query<{ id: string }>(
      `INSERT INTO public.email_outbox (recipient_email, subject, body_text, source_type, source_id, status)
       VALUES ('recipient@example.test', 'Subject', 'Body', 'employer_digest', $1, 'pending') RETURNING id`, [ids.employer],
    )).rows[0].id;
    ids.event = (await su.query<{ id: string }>(
      `INSERT INTO public.job_visibility_events (job_id, public_code, event_kind)
       SELECT id, public_code, 'published' FROM public.jobs WHERE id = $1 RETURNING id`, [ids.job],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!su) return;
    await su.query('DELETE FROM public.job_visibility_events WHERE id = $1', [ids.event]);
    await su.query('DELETE FROM public.email_outbox WHERE id = $1', [ids.email]);
    await su.query('DELETE FROM public.jobs WHERE id = ANY($1::uuid[])', [[ids.job, ids.otherJob]]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    await su.end();
  });

  it('an employer cannot re-point its own application at another worker or job (42501), but can change its status', async () => {
    for (const sql of [
      'UPDATE public.job_applications SET worker_id = $2 WHERE id = $1',
      'UPDATE public.job_applications SET job_id = $2 WHERE id = $1',
    ]) {
      const target = sql.includes('worker_id') ? ids.victim : ids.otherJob;
      expect([sql, await refusalAs('jale_api', employer(), sql, [ids.application, target])]).toEqual([sql, '42501']);
    }
    expect(await refusalAs('jale_api', employer(),
      `UPDATE public.job_applications SET status = 'contacted', updated_at = now() WHERE id = $1`, [ids.application])).toBeNull();
  });

  it('a conversation must name its application\'s worker and job, and the job\'s employer (23514)', async () => {
    const insert = `INSERT INTO public.job_conversations (job_id, employer_id, worker_id, application_id, status)
                    VALUES ($1, $2, $3, $4, 'open')`;
    // Another worker on the caller's own application, and another employer's applicant on the caller's own row.
    expect(await refusalAs('jale_api', employer(), insert, [ids.job, ids.employer, ids.victim, ids.application])).toBe('23514');
    expect(await refusalAs('jale_api', employer(), insert, [ids.otherJob, ids.employer, ids.victim, ids.otherApplication])).toBe('23514');
    expect(await refusalAs('jale_api', employer(), insert, [ids.job, ids.employer, ids.applicant, ids.application])).toBeNull();
  });

  it('an employer message is sent to the conversation\'s worker, whatever number the request supplies', async () => {
    const [conversation] = await rowsAs<{ id: string }>('jale_api', employer(),
      `INSERT INTO public.job_conversations (job_id, employer_id, worker_id, application_id, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`, [ids.job, ids.employer, ids.applicant, ids.application]);
    try {
      const [row] = await rowsAs<{ id: string }>('jale_api', employer(),
        `INSERT INTO public.job_message_outbox (conversation_id, whatsapp_number, send_kind, body)
         VALUES ($1, '+15559999999', 'freeform', 'Fixture') RETURNING id`, [conversation.id]);
      const { rows } = await su.query(
        'SELECT o.whatsapp_number, u.whatsapp_number AS own FROM public.job_message_outbox o, public.users u WHERE o.id = $1 AND u.id = $2',
        [row.id, ids.applicant]);
      expect(rows[0].whatsapp_number).toBe(rows[0].own);
      expect(await refusalAs('jale_api', employer(),
        `UPDATE public.job_message_outbox SET whatsapp_number = '+15559999999' WHERE id = $1`, [row.id])).toBe('42501');
      expect(await refusalAs('jale_api', employer(),
        `UPDATE public.job_message_outbox SET status = 'failed', attempt_count = attempt_count + 1, last_error = 'x' WHERE id = $1`, [row.id]))
        .toBeNull();
    } finally {
      await su.query('DELETE FROM public.job_conversations WHERE id = $1', [conversation.id]);
    }
  });

  it('a user cannot write its own identity, contact-link or trust columns (42501), but can edit its profile', async () => {
    const self = { sub: subs.applicant, internalUserId: ids.applicant };
    for (const set of [
      'trade_competency_score = 100', `whatsapp_number = '+15550009999'`, `email = 'someone-else@example.test'`,
      `user_type = 'employer'`, `cognito_sub = 'lp-cw-claimed'`,
    ]) {
      expect([set, await refusalAs('jale_api', self, `UPDATE public.users SET ${set} WHERE id = $1`, [ids.applicant])])
        .toEqual([set, '42501']);
    }
    expect(await refusalAs('jale_api', self, `UPDATE public.users SET full_name = 'Fixture Name', city = 'Austin' WHERE id = $1`, [ids.applicant]))
      .toBeNull();
  });

  it('the email sender cannot re-address or rewrite a queued email (42501), but can record its sending', async () => {
    for (const set of [
      `recipient_email = 'attacker@example.test'`, `subject = 'x'`, `body_text = 'click here'`, `body_html = '<p>x</p>'`,
      `headers = '{}'::jsonb`, `source_id = gen_random_uuid()`,
    ]) {
      expect([set, await refusalAs('jale_job_email_sender', {}, `UPDATE public.email_outbox SET ${set} WHERE id = $1`, [ids.email])])
        .toEqual([set, '42501']);
    }
    expect(await refusalAs('jale_job_email_sender', {},
      `UPDATE public.email_outbox SET status = 'failed', attempt_count = attempt_count + 1, last_error = 'x', next_attempt_at = NULL, sent_at = NULL
        WHERE id = $1`, [ids.email])).toBeNull();
  });

  it('the visibility drain cannot change what an event is about (42501), but can record its sending', async () => {
    for (const set of [`job_id = $2`, `event_kind = 'removed'`, `public_code = 'ABCDEFGH'`]) {
      const params = set.includes('$2') ? [ids.event, ids.otherJob] : [ids.event];
      expect([set, await refusalAs('jale_job_visibility_drain', {}, `UPDATE public.job_visibility_events SET ${set} WHERE id = $1`, params)])
        .toEqual([set, '42501']);
    }
    expect(await refusalAs('jale_job_visibility_drain', {},
      `UPDATE public.job_visibility_events SET status = 'sent', sent_at = now(), attempt_count = attempt_count + 1, last_error = NULL WHERE id = $1`,
      [ids.event])).toBeNull();
  });
});
