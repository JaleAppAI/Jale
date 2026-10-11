/**
 * digest-settings.integration.test.ts
 *
 * PostgreSQL-backed suite for migration 082 (employer_digest_settings, the
 * IANA timezone guard trigger, the email_outbox INSERT policy for jale_admin,
 * and the jale_digest_enumerator SECURITY DEFINER functions).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the
 * full migration chain (001->080) already applied, connected as a superuser
 * (e.g. `postgres`) so this suite can set role passwords and insert fixtures
 * via a separate jale_admin connection. When absent, every test in this file
 * is explicitly skipped and the concern is logged (no silent skip) -- mirrors
 * infra/test/unit/db/wage-references.integration.test.ts.
 *
 * Example (after running the Docker gate):
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/jale npx jest digest-settings
 *
 * Why fixtures go in as superuser but the interesting probes do not: both
 * `users` and `employer_digest_settings` are FORCE ROW LEVEL SECURITY, and a
 * superuser is not subject to RLS, so superuser writes are a convenient way to
 * arrange state. That same property makes a superuser useless for proving
 * anything about RLS -- every claim about who can see or change what is made
 * over a real non-superuser `jale_admin` connection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Harness helpers (mirrors wage-references.integration.test.ts)
// ---------------------------------------------------------------------------

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
      `[digest-settings.integration] SKIPPED: "${name}" -- set JALE_TEST_DATABASE_URL to run PostgreSQL-backed tests. ` +
        `This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.`,
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

/** Run a block as jale_admin with app.current_user_id set to the given cognito_sub. */
async function asEmployer<T>(cognitoSub: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(adminUrl, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [cognitoSub]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const SUB_A = 'digest-080-employer-a';
const SUB_B = 'digest-080-employer-b';
const SUB_LA = 'digest-080-employer-la';
const SUB_WORKER = 'digest-080-worker';
const ALL_SUBS = [SUB_A, SUB_B, SUB_LA, SUB_WORKER];

let superuserUrl: string;
let adminUrl: string;
const userIds = new Map<string, string>();

/**
 * Fixture id lookup that fails loudly.
 *
 * `userIds.get(missing)` returns undefined, node-postgres serialises undefined
 * as SQL NULL, and `WHERE employer_id = NULL` matches nothing -- so every
 * negative probe in this file ("A cannot see B's row", "unknown id changes
 * nothing", "the worker row is excluded") would pass vacuously if seeding had
 * silently failed. Routing every id through this accessor means a seeding
 * failure surfaces as a thrown error instead of a green suite.
 */
function idOf(sub: string): string {
  const id = userIds.get(sub);
  if (!id) {
    throw new Error(`fixture user id missing for ${sub} -- beforeAll seeding did not complete`);
  }
  return id;
}

/**
 * Plant a stale updated_at with the updated_at trigger disabled.
 *
 * set_updated_at() (001) unconditionally assigns NEW.updated_at = NOW() on
 * EVERY update, so a plain `SET updated_at = now() - interval '1 day'` is
 * overwritten by the trigger the instant it is written. A later "did
 * updated_at move?" assertion over such a plant is vacuously true and would
 * still pass with the trigger dropped entirely. Disabling the trigger for the
 * plant is what gives that assertion the power to fail.
 */
async function plantStaleUpdatedAt(employerId: string): Promise<void> {
  await withClient(superuserUrl, async (client) => {
    await client.query(
      `ALTER TABLE employer_digest_settings DISABLE TRIGGER employer_digest_settings_updated_at`,
    );
    try {
      await client.query(
        `UPDATE employer_digest_settings SET updated_at = now() - interval '1 day'
          WHERE employer_id = $1`,
        [employerId],
      );
    } finally {
      await client.query(
        `ALTER TABLE employer_digest_settings ENABLE TRIGGER employer_digest_settings_updated_at`,
      );
    }
  });

  // Self-check: prove the plant actually stuck, otherwise the assertion this
  // sets up cannot mean anything.
  const planted = await withClient(superuserUrl, (client) =>
    client.query<{ stale: boolean }>(
      `SELECT updated_at < now() - interval '1 hour' AS stale
         FROM employer_digest_settings WHERE employer_id = $1`,
      [employerId],
    ),
  );
  expect(planted.rows[0].stale).toBe(true);
}

/** Reset every fixture row to a known baseline (superuser: bypasses RLS). */
async function resetFixtures(): Promise<void> {
  await withClient(superuserUrl, async (client) => {
    await client.query(
      `UPDATE employer_digest_settings s
          SET enabled = false, send_hour_local = 8, timezone = 'America/Chicago',
              language = 'en', last_sent_at = NULL, unsubscribe_token_version = 1
        FROM users u
       WHERE u.id = s.employer_id AND u.cognito_sub = ANY($1::text[])`,
      [ALL_SUBS],
    );
  });
}

maybeDescribe('employer_digest_settings integration (migration 082)', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    superuserUrl = databaseUrl;
    await setServiceRolePasswords(superuserUrl);
    adminUrl =
      new URL(databaseUrl).username === 'jale_admin'
        ? databaseUrl
        : urlForRole(databaseUrl, 'jale_admin', 'test-admin-pw');

    await withClient(superuserUrl, async (client) => {
      // Clean up any residue from a previous run of this suite, then re-seed.
      await client.query(
        `DELETE FROM email_outbox WHERE recipient_email LIKE 'digest-080-%@example.test'`,
      );
      await client.query(
        `DELETE FROM employer_digest_settings
          WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
        [ALL_SUBS],
      );
      await client.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [ALL_SUBS]);

      for (const [sub, userType] of [
        [SUB_A, 'employer'],
        [SUB_B, 'employer'],
        [SUB_LA, 'employer'],
        [SUB_WORKER, 'worker'],
      ] as const) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type, email, phone, full_name, created_at, updated_at)
           VALUES ($1, $2, $3, '+15550000000', 'Digest Fixture', NOW(), NOW())
           RETURNING id`,
          [sub, userType, `${sub}@example.test`],
        );
        userIds.set(sub, inserted.rows[0].id);
      }

      // One settings row per fixture user, including the worker (the
      // due-employers function must exclude it on user_type, not on absence).
      for (const sub of ALL_SUBS) {
        await client.query(
          `INSERT INTO employer_digest_settings (employer_id, enabled, send_hour_local, timezone, language)
           VALUES ($1, false, 8, 'America/Chicago', 'en')`,
          [idOf(sub)],
        );
      }
    });

    // Seeding must be complete before any test runs -- see idOf()'s comment on
    // why a half-seeded fixture set would turn the negative probes green.
    expect(userIds.size).toBe(ALL_SUBS.length);
    for (const sub of ALL_SUBS) {
      expect(typeof userIds.get(sub)).toBe('string');
      expect(userIds.get(sub)).toBeTruthy();
    }
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superuserUrl, async (client) => {
      await client.query(
        `DELETE FROM email_outbox WHERE recipient_email LIKE 'digest-080-%@example.test'`,
      );
      await client.query(
        `DELETE FROM employer_digest_settings
          WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
        [ALL_SUBS],
      );
      await client.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [ALL_SUBS]);
    });
  }, 60_000);

  beforeEach(async () => {
    if (!databaseUrl) return;
    await resetFixtures();
  });

  // -------------------------------------------------------------------------
  // 1. Cross-employer RLS: employer_digest_settings_self must be tenant-tight
  // -------------------------------------------------------------------------
  describe('cross-employer RLS on employer_digest_settings', () => {
    it('an employer reads exactly one row -- their own', async () => {
      if (!databaseUrl) return;
      const rows = await asEmployer(SUB_A, (client) =>
        client.query<{ employer_id: string }>(`SELECT employer_id FROM employer_digest_settings`),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].employer_id).toBe(idOf(SUB_A));
    });

    it("employer A cannot SELECT employer B's row even when naming its id explicitly", async () => {
      if (!databaseUrl) return;
      const rows = await asEmployer(SUB_A, (client) =>
        client.query(`SELECT employer_id FROM employer_digest_settings WHERE employer_id = $1`, [
          idOf(SUB_B),
        ]),
      );
      expect(rows.rows).toHaveLength(0);
    });

    it("employer A's UPDATE of employer B's row fails SILENTLY (0 rows) -- the documented RLS asymmetry", async () => {
      if (!databaseUrl) return;
      const result = await asEmployer(SUB_A, (client) =>
        client.query(`UPDATE employer_digest_settings SET enabled = true WHERE employer_id = $1`, [
          idOf(SUB_B),
        ]),
      );
      expect(result.rowCount).toBe(0);

      // Prove B genuinely was not touched (belt-and-braces on the silent-zero).
      const check = await withClient(superuserUrl, (client) =>
        client.query<{ enabled: boolean }>(
          `SELECT enabled FROM employer_digest_settings WHERE employer_id = $1`,
          [idOf(SUB_B)],
        ),
      );
      expect(check.rows[0].enabled).toBe(false);
    });

    it("employer A's INSERT of a row for employer B fails LOUDLY (WITH CHECK)", async () => {
      if (!databaseUrl) return;
      await expect(
        asEmployer(SUB_A, (client) =>
          client.query(
            `INSERT INTO employer_digest_settings (employer_id, enabled) VALUES ($1, true)`,
            [idOf(SUB_B)],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('employer A can UPDATE their own row, and the updated_at trigger moves the timestamp', async () => {
      if (!databaseUrl) return;
      const before = await withClient(superuserUrl, (client) =>
        client.query<{ updated_at: Date }>(
          `SELECT updated_at FROM employer_digest_settings WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      // Force a distinguishable baseline so the assertion cannot pass on clock
      // granularity alone -- and plant it with the trigger off, or the trigger
      // overwrites the plant and the `fresh` assertion below becomes vacuous.
      await plantStaleUpdatedAt(idOf(SUB_A));
      expect(before.rows).toHaveLength(1);

      const result = await asEmployer(SUB_A, (client) =>
        client.query(`UPDATE employer_digest_settings SET enabled = true, language = 'es'`),
      );
      expect(result.rowCount).toBe(1);

      const after = await withClient(superuserUrl, (client) =>
        client.query<{ enabled: boolean; language: string; fresh: boolean }>(
          `SELECT enabled, language, updated_at > now() - interval '1 minute' AS fresh
             FROM employer_digest_settings WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      expect(after.rows[0].enabled).toBe(true);
      expect(after.rows[0].language).toBe('es');
      expect(after.rows[0].fresh).toBe(true);
    });

    it('a bare jale_admin connection with NO app.current_user_id set reads zero rows', async () => {
      if (!databaseUrl) return;
      const rows = await withClient(adminUrl, (client) =>
        client.query(`SELECT employer_id FROM employer_digest_settings`),
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. email_outbox: the source_type-scoped INSERT policy for jale_admin
  // -------------------------------------------------------------------------
  describe('email_outbox INSERT policy for jale_admin', () => {
    it("accepts an INSERT with source_type = 'employer_digest'", async () => {
      if (!databaseUrl) return;
      const result = await withClient(adminUrl, (client) =>
        client.query(
          `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id)
           VALUES ('digest-080-ok@example.test', 'Your daily digest', 'body', 'employer_digest', $1)`,
          [idOf(SUB_A)],
        ),
      );
      expect(result.rowCount).toBe(1);
    });

    it("rejects an INSERT with a DIFFERENT valid source_type, and the failure is the RLS policy (not a CHECK, not a missing grant)", async () => {
      if (!databaseUrl) return;
      // 'billing_pause' satisfies email_outbox's own source_type CHECK
      // (037:13, ^[a-z0-9_:-]+$), and jale_admin OWNS email_outbox (037:34) so
      // INSERT privilege is implicit via ownership. The ONLY thing that can
      // reject this row is email_outbox_admin_insert's WITH CHECK, which is
      // exactly what this test pins.
      await expect(
        withClient(adminUrl, (client) =>
          client.query(
            `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id)
             VALUES ('digest-080-nope@example.test', 'Not a digest', 'body', 'billing_pause', $1)`,
            [idOf(SUB_A)],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  // -------------------------------------------------------------------------
  // 3. due_digest_employers: the definer bypass, and the hour/date logic
  // -------------------------------------------------------------------------
  describe('jale_digest_internal.due_digest_employers', () => {
    interface DueRow {
      employer_id: string;
      cognito_sub: string;
      email: string;
      send_hour_local: number;
      timezone: string;
      language: string;
      unsubscribe_token_version: number;
    }

    /**
     * Call the definer function as plain jale_admin with NO GUC set.
     *
     * ALL_SUBS.map(idOf) throws rather than producing a NULL array element: a
     * nullish id would silently drop that employer from the `= ANY(...)`
     * filter and turn an absence assertion green for the wrong reason.
     */
    async function due(pNow: string): Promise<DueRow[]> {
      const ids = ALL_SUBS.map((s) => idOf(s));
      const result = await withClient(adminUrl, (client) =>
        client.query<DueRow>(
          `SELECT employer_id, cognito_sub, email, send_hour_local, timezone, language,
                  unsubscribe_token_version
             FROM jale_digest_internal.due_digest_employers($1::timestamptz)
            WHERE employer_id = ANY($2::uuid[])
            ORDER BY email`,
          [pNow, ids],
        ),
      );
      return result.rows;
    }

    it('returns a due employer over a connection that cannot read the table directly (the definer bypass)', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings SET enabled = true, send_hour_local = 8, timezone = 'America/New_York'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );

      // Same connection, same absence of app.current_user_id: the direct read
      // sees nothing, the definer function sees the row. That contrast IS the
      // point -- run as a superuser both halves would succeed and prove nothing.
      await withClient(adminUrl, async (client) => {
        const direct = await client.query(`SELECT employer_id FROM employer_digest_settings`);
        expect(direct.rows).toHaveLength(0);

        const viaDefiner = await client.query<{ employer_id: string }>(
          `SELECT employer_id FROM jale_digest_internal.due_digest_employers('2026-01-15 13:00:00+00'::timestamptz)
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        );
        expect(viaDefiner.rows).toHaveLength(1);
      });
    });

    it('matches the wall-clock hour in each row\'s OWN zone, so two employers at "8am" are due at different UTC instants', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, async (client) => {
        await client.query(
          `UPDATE employer_digest_settings SET enabled = true, send_hour_local = 8, timezone = 'America/New_York', language = 'en'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        );
        await client.query(
          `UPDATE employer_digest_settings SET enabled = true, send_hour_local = 8, timezone = 'America/Los_Angeles', language = 'es'
            WHERE employer_id = $1`,
          [idOf(SUB_LA)],
        );
      });

      // 13:00Z is 08:00 in New York (UTC-5 in January) and 05:00 in Los Angeles.
      const atNewYorkMorning = await due('2026-01-15 13:00:00+00');
      expect(atNewYorkMorning.map((r) => r.timezone)).toEqual(['America/New_York']);
      expect(atNewYorkMorning[0].language).toBe('en');

      // 16:00Z is 08:00 in Los Angeles and 11:00 in New York.
      const atLosAngelesMorning = await due('2026-01-15 16:00:00+00');
      expect(atLosAngelesMorning.map((r) => r.timezone)).toEqual(['America/Los_Angeles']);
      expect(atLosAngelesMorning[0].language).toBe('es');

      // An hour that is nobody's send hour.
      expect(await due('2026-01-15 14:00:00+00')).toHaveLength(0);
    });

    it('the caller session TimeZone cannot change who is due', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings SET enabled = true, send_hour_local = 8, timezone = 'America/Los_Angeles'
            WHERE employer_id = $1`,
          [idOf(SUB_LA)],
        ),
      );

      const counts: number[] = [];
      for (const sessionZone of ['UTC', 'America/New_York', 'Etc/GMT+5']) {
        const result = await withClient(adminUrl, async (client) => {
          await client.query(`SET TIME ZONE '${sessionZone}'`);
          return client.query(
            `SELECT employer_id FROM jale_digest_internal.due_digest_employers('2026-01-15 16:00:00+00'::timestamptz)
              WHERE employer_id = $1`,
            [idOf(SUB_LA)],
          );
        });
        counts.push(result.rows.length);
      }
      expect(counts).toEqual([1, 1, 1]);
    });

    it('compares the watermark as a LOCAL date: same local day is not due, next local day is', async () => {
      if (!databaseUrl) return;
      // last_sent_at 2026-01-15 13:00Z == 2026-01-15 08:00 New York.
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York',
                  last_sent_at = '2026-01-15 13:00:00+00'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );

      expect(await due('2026-01-15 13:00:00+00')).toHaveLength(0);
      const nextDay = await due('2026-01-16 13:00:00+00');
      expect(nextDay).toHaveLength(1);
      expect(nextDay[0].employer_id).toBe(idOf(SUB_A));
    });

    it('returns unsubscribe_token_version so the producer can mint the token without a second query', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York',
                  unsubscribe_token_version = 7
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );

      const rows = await due('2026-01-15 13:00:00+00');
      expect(rows).toHaveLength(1);
      expect(rows[0].employer_id).toBe(idOf(SUB_A));
      // The actual stored value, not merely a non-null: the producer signs the
      // unsubscribe link with this, so an off-by-one would mint links that the
      // unsubscribe function then refuses.
      expect(rows[0].unsubscribe_token_version).toBe(7);
      // And the version it hands back must be the one unsubscribe accepts.
      const flipped = await withClient(adminUrl, (client) =>
        client.query<{ flipped: boolean }>(
          `SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS flipped`,
          [rows[0].employer_id, rows[0].unsubscribe_token_version],
        ),
      );
      expect(flipped.rows[0].flipped).toBe(true);
    });

    it('returns the addressing fields the producer needs (cognito_sub, email, hour)', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York', language = 'es'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      const rows = await due('2026-01-15 13:00:00+00');
      expect(rows).toHaveLength(1);
      expect(rows[0].cognito_sub).toBe(SUB_A);
      expect(rows[0].email).toBe(`${SUB_A}@example.test`);
      expect(rows[0].send_hour_local).toBe(8);
      expect(rows[0].language).toBe('es');
    });

    it('skips ONLY the employer whose stored zone has left tzdata, and still returns everyone else', async () => {
      if (!databaseUrl) return;
      // The tzdata-shrink scenario the migration header describes. `AT TIME
      // ZONE <unlisted>` RAISES rather than returning NULL, so before the
      // MATERIALIZED pre-join on pg_timezone_names a single such row aborted
      // the whole RETURN QUERY and NOBODY got a digest. This test pins that it
      // is now a per-row skip.
      //
      // 'US/Pacific' is a real historical zone name that Debian trixie moved
      // into the separate tzdata-legacy package, so it is genuinely absent from
      // this host's pg_timezone_names -- exactly the shape of the failure,
      // rather than a synthetic string. Confirm that premise before relying on
      // it, since on a host WITH tzdata-legacy the row would simply be valid
      // and the test would prove nothing.
      const listed = await withClient(superuserUrl, (client) =>
        client.query<{ present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = 'US/Pacific') AS present`,
        ),
      );
      expect(listed.rows[0].present).toBe(false);

      await withClient(superuserUrl, async (client) => {
        // Both guards must come off: the IANA trigger would refuse the write,
        // and it is the only thing standing between us and the planted state.
        await client.query(
          `ALTER TABLE employer_digest_settings DISABLE TRIGGER employer_digest_settings_timezone_iana`,
        );
        try {
          await client.query(
            `UPDATE employer_digest_settings
                SET enabled = true, send_hour_local = 8, timezone = 'US/Pacific'
              WHERE employer_id = $1`,
            [idOf(SUB_B)],
          );
        } finally {
          await client.query(
            `ALTER TABLE employer_digest_settings ENABLE TRIGGER employer_digest_settings_timezone_iana`,
          );
        }
        // A second, healthy employer due at the same instant.
        await client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        );
      });

      try {
        const rows = await due('2026-01-15 13:00:00+00');
        // The healthy employer is still served -- this is the assertion that
        // would have thrown 22023 before the fence.
        expect(rows.map((r) => r.employer_id)).toEqual([idOf(SUB_A)]);
        expect(rows.map((r) => r.employer_id)).not.toContain(idOf(SUB_B));
      } finally {
        await withClient(superuserUrl, (client) =>
          client.query(
            `UPDATE employer_digest_settings SET timezone = 'America/Chicago', enabled = false
              WHERE employer_id = $1`,
            [idOf(SUB_B)],
          ),
        );
      }
    });

    it('a NULL watermark is due on the first matching hour', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York', last_sent_at = NULL
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      expect(await due('2026-01-15 13:00:00+00')).toHaveLength(1);
    });

    it('excludes a disabled row even when the hour matches', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = false, send_hour_local = 8, timezone = 'America/New_York'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      expect(await due('2026-01-15 13:00:00+00')).toHaveLength(0);
    });

    it("excludes a worker's settings row on user_type, even when enabled and the hour matches", async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York'
            WHERE employer_id = $1`,
          [idOf(SUB_WORKER)],
        ),
      );
      const rows = await due('2026-01-15 13:00:00+00');
      expect(rows.map((r) => r.employer_id)).not.toContain(idOf(SUB_WORKER));
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. unsubscribe_employer: token-version gating
  // -------------------------------------------------------------------------
  describe('jale_digest_internal.unsubscribe_employer', () => {
    async function unsubscribe(employerId: string, version: number): Promise<boolean> {
      const result = await withClient(adminUrl, (client) =>
        client.query<{ flipped: boolean }>(
          `SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS flipped`,
          [employerId, version],
        ),
      );
      return result.rows[0].flipped;
    }

    async function enabledOf(employerId: string): Promise<boolean> {
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ enabled: boolean }>(
          `SELECT enabled FROM employer_digest_settings WHERE employer_id = $1`,
          [employerId],
        ),
      );
      return result.rows[0].enabled;
    }

    beforeEach(async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings SET enabled = true, unsubscribe_token_version = 3
            WHERE employer_id = ANY($1::uuid[])`,
          [[idOf(SUB_A), idOf(SUB_B)]],
        ),
      );
    });

    it('flips enabled to false and returns true on a version match', async () => {
      if (!databaseUrl) return;
      expect(await unsubscribe(idOf(SUB_A), 3)).toBe(true);
      expect(await enabledOf(idOf(SUB_A))).toBe(false);
    });

    it('returns false and changes nothing on a stale version (a bumped version invalidates old links)', async () => {
      if (!databaseUrl) return;
      expect(await unsubscribe(idOf(SUB_A), 2)).toBe(false);
      expect(await enabledOf(idOf(SUB_A))).toBe(true);
    });

    it('returns false and changes nothing for an unknown employer id', async () => {
      if (!databaseUrl) return;
      expect(await unsubscribe('00000000-0000-0000-0000-000000000000', 3)).toBe(false);
      expect(await enabledOf(idOf(SUB_A))).toBe(true);
    });

    it("touches only the addressed employer, never a neighbour's row", async () => {
      if (!databaseUrl) return;
      expect(await unsubscribe(idOf(SUB_A), 3)).toBe(true);
      expect(await enabledOf(idOf(SUB_B))).toBe(true);
    });

    it('cannot change any column other than enabled (single-column UPDATE grant), and the trigger still maintains updated_at', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET timezone = 'America/New_York', send_hour_local = 6, language = 'es'
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      // Separate, trigger-disabled plant: folding `updated_at = now() - 1 day`
      // into the UPDATE above would be undone by the trigger on that same
      // statement, leaving the `fresh` assertion below unable to fail.
      await plantStaleUpdatedAt(idOf(SUB_A));

      expect(await unsubscribe(idOf(SUB_A), 3)).toBe(true);

      const after = await withClient(superuserUrl, (client) =>
        client.query<{
          enabled: boolean;
          timezone: string;
          send_hour_local: number;
          language: string;
          unsubscribe_token_version: number;
          fresh: boolean;
        }>(
          `SELECT enabled, timezone, send_hour_local, language, unsubscribe_token_version,
                  updated_at > now() - interval '1 minute' AS fresh
             FROM employer_digest_settings WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      expect(after.rows[0].enabled).toBe(false);
      expect(after.rows[0].timezone).toBe('America/New_York');
      expect(after.rows[0].send_hour_local).toBe(6);
      expect(after.rows[0].language).toBe('es');
      expect(after.rows[0].unsubscribe_token_version).toBe(3);
      // The function is granted UPDATE on `enabled` only, so it structurally
      // cannot set updated_at -- the BEFORE UPDATE trigger does it instead.
      // Postgres checks column privileges against the statement's SET list,
      // not against what a trigger later assigns to NEW.
      expect(after.rows[0].fresh).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The IANA timezone guard trigger
  // -------------------------------------------------------------------------
  describe('timezone validation', () => {
    // Deliberately NOT using US/Pacific or EST5EDT in either direction: Debian
    // trixie moved the tzdata compatibility link names into the separate
    // tzdata-legacy package, so those names are PRESENT on RDS and ABSENT on
    // the Debian-13 testbed image. A test naming them would flip meaning with
    // the host, in whichever direction it was written.
    const ACCEPTED = [
      'America/New_York',
      'America/Mexico_City',
      'America/Los_Angeles',
      'UTC',
      'Etc/GMT+5',
    ];

    const REJECTED = [
      'Zzz/Not_A_Zone', // simply not a zone
      'FOOBAR8', // POSIX-style TZ spec: `AT TIME ZONE` ACCEPTS this, so it is
      //           the case that proves the trigger, not a cast, is the validator
      'localtime', // listed by pg_timezone_names but host-relative
      'posixrules', // listed by pg_timezone_names but a DST-rule template
      'Factory', // listed by pg_timezone_names but a placeholder
      '  America/New_York  ', // padded: a real zone name that is not a real value
      'america/new_york', // matching is case-sensitive by design
    ];

    for (const zone of ACCEPTED) {
      it(`accepts ${JSON.stringify(zone)}`, async () => {
        if (!databaseUrl) return;
        const result = await asEmployer(SUB_A, (client) =>
          client.query(`UPDATE employer_digest_settings SET timezone = $1`, [zone]),
        );
        expect(result.rowCount).toBe(1);

        const stored = await withClient(superuserUrl, (client) =>
          client.query<{ timezone: string }>(
            `SELECT timezone FROM employer_digest_settings WHERE employer_id = $1`,
            [idOf(SUB_A)],
          ),
        );
        expect(stored.rows[0].timezone).toBe(zone);
      });
    }

    for (const zone of REJECTED) {
      it(`rejects ${JSON.stringify(zone)} loudly`, async () => {
        if (!databaseUrl) return;
        // A BEFORE ROW trigger fires before CHECK constraints are evaluated,
        // so even the padded value -- which also violates
        // employer_digest_settings_timezone_shape -- surfaces the trigger's
        // message. The shape CHECK is defence-in-depth, not first responder;
        // its presence is asserted from the catalog below.
        await expect(
          asEmployer(SUB_A, (client) =>
            client.query(`UPDATE employer_digest_settings SET timezone = $1`, [zone]),
          ),
        ).rejects.toThrow(/invalid IANA time zone/i);

        const stored = await withClient(superuserUrl, (client) =>
          client.query<{ timezone: string }>(
            `SELECT timezone FROM employer_digest_settings WHERE employer_id = $1`,
            [idOf(SUB_A)],
          ),
        );
        expect(stored.rows[0].timezone).toBe('America/Chicago');
      });
    }

    it('rejects an invalid zone on INSERT as well as UPDATE', async () => {
      if (!databaseUrl) return;
      await withClient(superuserUrl, (client) =>
        client.query(`DELETE FROM employer_digest_settings WHERE employer_id = $1`, [
          idOf(SUB_B),
        ]),
      );
      try {
        await expect(
          asEmployer(SUB_B, (client) =>
            client.query(
              `INSERT INTO employer_digest_settings (employer_id, timezone) VALUES ($1, 'Zzz/Not_A_Zone')`,
              [idOf(SUB_B)],
            ),
          ),
        ).rejects.toThrow(/invalid IANA time zone/i);
      } finally {
        await withClient(superuserUrl, (client) =>
          client.query(
            `INSERT INTO employer_digest_settings (employer_id) VALUES ($1)
             ON CONFLICT (employer_id) DO NOTHING`,
            [idOf(SUB_B)],
          ),
        );
      }
    });

    it('re-saving an unchanged timezone short-circuits, so a row stays updatable even if its zone leaves tzdata', async () => {
      if (!databaseUrl) return;
      // The scenario this guards is "the value was accepted when it was
      // stored, and the accept-set shrank afterwards" -- Debian trixie moving
      // the tzdata link names into tzdata-legacy is a real instance. There is
      // no way to reach that state through a normal write, because the guard
      // trigger fires for EVERY writer including a superuser (a trigger is not
      // RLS). So plant the value with the trigger disabled, then re-enable it
      // before making any assertion.
      await withClient(superuserUrl, async (client) => {
        await client.query(
          `ALTER TABLE employer_digest_settings DISABLE TRIGGER employer_digest_settings_timezone_iana`,
        );
        try {
          await client.query(
            `UPDATE employer_digest_settings SET timezone = 'Factory' WHERE employer_id = $1`,
            [idOf(SUB_A)],
          );
        } finally {
          await client.query(
            `ALTER TABLE employer_digest_settings ENABLE TRIGGER employer_digest_settings_timezone_iana`,
          );
        }
      });

      try {
        // (a) An UPDATE that does not name timezone never fires the trigger at
        //     all -- that is what BEFORE ... UPDATE OF timezone buys. Without
        //     it the employer could not even turn the digest off.
        const other = await asEmployer(SUB_A, (client) =>
          client.query(`UPDATE employer_digest_settings SET enabled = true`),
        );
        expect(other.rowCount).toBe(1);

        // (b) An explicit re-assignment of the SAME value does fire the
        //     trigger, and the TG_OP / IS NOT DISTINCT FROM short-circuit lets
        //     it through -- so a settings PATCH that echoes the stored zone
        //     back is not a trap either.
        const noop = await asEmployer(SUB_A, (client) =>
          client.query(`UPDATE employer_digest_settings SET timezone = 'Factory'`),
        );
        expect(noop.rowCount).toBe(1);

        // (c) But moving OFF the stale value to another invalid one is still
        //     refused: the short-circuit narrows re-validation, it does not
        //     disable it.
        await expect(
          asEmployer(SUB_A, (client) =>
            client.query(`UPDATE employer_digest_settings SET timezone = 'Zzz/Not_A_Zone'`),
          ),
        ).rejects.toThrow(/invalid IANA time zone/i);
      } finally {
        // Never leave a value the guard would refuse behind for other tests.
        await withClient(superuserUrl, (client) =>
          client.query(
            `UPDATE employer_digest_settings SET timezone = 'America/Chicago' WHERE employer_id = $1`,
            [idOf(SUB_A)],
          ),
        );
      }
    });

    it('the shape CHECK and both triggers are present in the catalog', async () => {
      if (!databaseUrl) return;
      const shape = await withClient(superuserUrl, (client) =>
        client.query(
          `SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
            WHERE rel.relname = 'employer_digest_settings' AND c.contype = 'c'
              AND c.conname = 'employer_digest_settings_timezone_shape'`,
        ),
      );
      expect(shape.rows).toHaveLength(1);

      const triggers = await withClient(superuserUrl, (client) =>
        client.query<{ tgname: string }>(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_class rel ON rel.oid = t.tgrelid
            WHERE rel.relname = 'employer_digest_settings' AND NOT t.tgisinternal
            ORDER BY t.tgname`,
        ),
      );
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        'employer_digest_settings_timezone_iana',
        'employer_digest_settings_updated_at',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 6. jale_digest_enumerator privilege surface
  // -------------------------------------------------------------------------
  describe('jale_digest_enumerator privilege surface', () => {
    it('reads exactly four users columns and none of the PII ones', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.column_privileges
            WHERE grantee = 'jale_digest_enumerator' AND table_schema = 'public'
              AND table_name = 'users' AND privilege_type = 'SELECT'
            ORDER BY column_name`,
        ),
      );
      expect(result.rows.map((r) => r.column_name)).toEqual([
        'cognito_sub',
        'email',
        'id',
        'user_type',
      ]);
    });

    it('has UPDATE on employer_digest_settings.enabled and on no other column', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.column_privileges
            WHERE grantee = 'jale_digest_enumerator' AND table_schema = 'public'
              AND table_name = 'employer_digest_settings' AND privilege_type = 'UPDATE'
            ORDER BY column_name`,
        ),
      );
      expect(result.rows.map((r) => r.column_name)).toEqual(['enabled']);
    });

    it('is NOLOGIN and NOBYPASSRLS', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean; rolinherit: boolean }>(
          `SELECT rolcanlogin, rolbypassrls, rolsuper, rolinherit FROM pg_roles
            WHERE rolname = 'jale_digest_enumerator'`,
        ),
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        rolcanlogin: false,
        rolbypassrls: false,
        rolsuper: false,
        rolinherit: false,
      });
    });

    it('leaves exactly one role membership: jale_admin, ADMIN yes / INHERIT no / SET no, granted by a superuser', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{
          member: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
          grantor_is_super: boolean;
        }>(
          `SELECT member.rolname AS member, m.admin_option, m.inherit_option, m.set_option,
                  grantor.rolsuper AS grantor_is_super
             FROM pg_auth_members m
             JOIN pg_roles granted ON granted.oid = m.roleid
             JOIN pg_roles member ON member.oid = m.member
             JOIN pg_roles grantor ON grantor.oid = m.grantor
            WHERE granted.rolname = 'jale_digest_enumerator'
               OR member.rolname = 'jale_digest_enumerator'`,
        ),
      );
      expect(result.rows).toEqual([
        {
          member: 'jale_admin',
          admin_option: true,
          inherit_option: false,
          set_option: false,
          grantor_is_super: true,
        },
      ]);
    });

    it('grants no other service role any privilege on employer_digest_settings', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ grantee: string }>(
          `SELECT DISTINCT grantee FROM information_schema.table_privileges
            WHERE table_schema = 'public' AND table_name = 'employer_digest_settings'
              AND grantee = ANY(ARRAY['jale_whatsapp', 'jale_matching', 'jale_billing',
                                      'jale_ai', 'jale_public_jobs', 'jale_admin_console'])
           UNION
           SELECT DISTINCT grantee FROM information_schema.column_privileges
            WHERE table_schema = 'public' AND table_name = 'employer_digest_settings'
              AND grantee = ANY(ARRAY['jale_whatsapp', 'jale_matching', 'jale_billing',
                                      'jale_ai', 'jale_public_jobs', 'jale_admin_console'])`,
        ),
      );
      expect(result.rows).toEqual([]);
    });

    it('keeps the private schema owned by the enumerator with no PUBLIC access', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ owner: string; public_usage: boolean }>(
          `SELECT r.rolname AS owner,
                  EXISTS (
                    SELECT 1 FROM pg_namespace n2,
                      LATERAL aclexplode(COALESCE(n2.nspacl, acldefault('n', n2.nspowner))) acl
                     WHERE n2.oid = n.oid AND acl.grantee = 0
                  ) AS public_usage
             FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
            WHERE n.nspname = 'jale_digest_internal'`,
        ),
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].owner).toBe('jale_digest_enumerator');
      expect(result.rows[0].public_usage).toBe(false);
    });

    it('exposes both digest functions as SECURITY DEFINER owned by the enumerator, with a pinned search_path', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{ proname: string; owner: string; prosecdef: boolean; proconfig: string[] }>(
          `SELECT f.proname, owner.rolname AS owner, f.prosecdef, f.proconfig
             FROM pg_proc f
             JOIN pg_namespace n ON n.oid = f.pronamespace
             JOIN pg_roles owner ON owner.oid = f.proowner
            WHERE n.nspname = 'jale_digest_internal'
            ORDER BY f.proname`,
        ),
      );
      expect(result.rows.map((r) => r.proname)).toEqual([
        'due_digest_employers',
        'unsubscribe_employer',
      ]);
      for (const row of result.rows) {
        expect(row.owner).toBe('jale_digest_enumerator');
        expect(row.prosecdef).toBe(true);
        expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. Re-apply idempotence -- LAST in the file on purpose
  //
  // Re-executing 080 drops and recreates every policy, trigger, and definer
  // function it owns. Any test that ran after this one would be racing that
  // churn, so this block is deliberately the final describe in the file.
  //
  // The value over the migration runner's own apply is twofold: it exercises
  // node-postgres's simple-query path (the whole file as ONE multi-statement
  // query, rather than psql's statement-at-a-time -f) and it runs 080's
  // terminal verification block against a POPULATED database, where the
  // fixtures above already exist -- a stronger test of those invariants than
  // the empty-schema apply the chain gate performs.
  // -------------------------------------------------------------------------
  describe('re-apply idempotence (migration text executed a second time)', () => {
    const migrationPath = path.join(
      __dirname, '..', '..', '..', 'db', 'migrations', '082_employer_digest_settings.sql',
    );

    it('re-executing the whole migration over a jale_admin connection succeeds', async () => {
      if (!databaseUrl) return;
      const sql = fs.readFileSync(migrationPath, 'utf8');
      // Sanity: we are running the real file, not an empty read.
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS employer_digest_settings');
      expect(sql).toContain('COMMIT;');

      // One simple query carrying BEGIN; ... COMMIT; and several DO blocks.
      // If the migration's own terminal verification block finds anything
      // wrong with the state it just re-established, this rejects.
      await withClient(adminUrl, (client) => client.query(sql));
    }, 120_000);

    it('still leaves exactly one enumerator membership with no SET or INHERIT', async () => {
      if (!databaseUrl) return;
      const result = await withClient(superuserUrl, (client) =>
        client.query<{
          member: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
          grantor_is_super: boolean;
        }>(
          `SELECT member.rolname AS member, m.admin_option, m.inherit_option, m.set_option,
                  grantor.rolsuper AS grantor_is_super
             FROM pg_auth_members m
             JOIN pg_roles granted ON granted.oid = m.roleid
             JOIN pg_roles member ON member.oid = m.member
             JOIN pg_roles grantor ON grantor.oid = m.grantor
            WHERE granted.rolname = 'jale_digest_enumerator'
               OR member.rolname = 'jale_digest_enumerator'`,
        ),
      );
      expect(result.rows).toEqual([
        {
          member: 'jale_admin',
          admin_option: true,
          inherit_option: false,
          set_option: false,
          grantor_is_super: true,
        },
      ]);
    });

    it('still has exactly the expected policies, triggers, and two definer functions', async () => {
      if (!databaseUrl) return;
      const state = await withClient(superuserUrl, async (client) => {
        const policies = await client.query<{ polname: string }>(
          `SELECT p.polname FROM pg_policy p JOIN pg_class rel ON rel.oid = p.polrelid
            WHERE rel.relname = 'employer_digest_settings' ORDER BY p.polname`,
        );
        const triggers = await client.query<{ tgname: string }>(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_class rel ON rel.oid = t.tgrelid
            WHERE rel.relname = 'employer_digest_settings' AND NOT t.tgisinternal
            ORDER BY t.tgname`,
        );
        const functions = await client.query<{ proname: string; prosecdef: boolean }>(
          `SELECT f.proname, f.prosecdef FROM pg_proc f
             JOIN pg_namespace n ON n.oid = f.pronamespace
            WHERE n.nspname = 'jale_digest_internal' ORDER BY f.proname`,
        );
        return {
          policies: policies.rows.map((r) => r.polname),
          triggers: triggers.rows.map((r) => r.tgname),
          functions: functions.rows,
        };
      });

      // Exact, not a superset, on purpose: a stray permissive policy on this
      // table is a second way in that ORs with every other one. The two
      // delivery_feedback entries are migration 090's — the bounce handler's
      // GUC-gated path, which exists because FORCE RLS means even jale_admin
      // cannot run a service-wide UPDATE here. Adding a name to this list
      // should always be a deliberate act.
      expect(state.policies).toEqual([
        'employer_digest_settings_delivery_feedback_select',
        'employer_digest_settings_delivery_feedback_update',
        'employer_digest_settings_digest_enumerator_select',
        'employer_digest_settings_digest_enumerator_update',
        'employer_digest_settings_self',
      ]);
      expect(state.triggers).toEqual([
        'employer_digest_settings_timezone_iana',
        'employer_digest_settings_updated_at',
      ]);
      expect(state.functions).toEqual([
        { proname: 'due_digest_employers', prosecdef: true },
        { proname: 'unsubscribe_employer', prosecdef: true },
      ]);
    });

    it('the re-applied definer function still answers the due question and still returns the token version', async () => {
      if (!databaseUrl) return;
      // Proves the recreated function is wired up (grants, policies, owner),
      // not merely present in the catalog.
      await withClient(superuserUrl, (client) =>
        client.query(
          `UPDATE employer_digest_settings
              SET enabled = true, send_hour_local = 8, timezone = 'America/New_York',
                  last_sent_at = NULL, unsubscribe_token_version = 5
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      const rows = await withClient(adminUrl, (client) =>
        client.query<{ employer_id: string; unsubscribe_token_version: number }>(
          `SELECT employer_id, unsubscribe_token_version
             FROM jale_digest_internal.due_digest_employers('2026-01-15 13:00:00+00'::timestamptz)
            WHERE employer_id = $1`,
          [idOf(SUB_A)],
        ),
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].unsubscribe_token_version).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// If DB is unavailable, emit a single top-level concern notice so CI captures it
// ---------------------------------------------------------------------------
if (!databaseUrl) {
  test('CONCERN: digest-settings-integration PostgreSQL gate was not run -- JALE_TEST_DATABASE_URL not set', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[digest-settings.integration] DONE_WITH_CONCERNS: The PostgreSQL gate for migration 082 was skipped ' +
        'because JALE_TEST_DATABASE_URL is not set in this environment. Run with a local Postgres 16 ' +
        'container (via infra/db/local/bootstrap-testbed.sh) to validate all digest-settings assertions.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}
