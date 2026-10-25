/**
 * user-tutorial-progress.integration.test.ts
 *
 * Migration 130 (tutorial progress, contract K1) on a real PostgreSQL 16
 * bed, through the real logins:
 *
 *   - the request login (jale_api) reads and inserts the caller's own rows
 *     only, with the caller context the handlers set; it cannot insert a row
 *     for another account, and it holds no UPDATE, DELETE or TRUNCATE;
 *   - the CHECKs refuse an id of the wrong shape and an unknown outcome;
 *   - a row leaves with its users row (ON DELETE CASCADE), including on the
 *     WhatsApp sign-in reconcile, whose placeholder delete
 *     (lambda/whatsapp/processor.ts, reconcileUserRow) keeps working on
 *     jale_whatsapp and leaves a web account's rows alone;
 *   - the handler (lambda/api/tutorial-progress.ts) on jale_api: the role's
 *     records only, the first outcome kept, 404 without a users row, and two
 *     records at once store one row.
 *
 * Fixtures and every read that decides an assertion go through the
 * superuser URL; code under test runs on its own login (login-pool.ts). The
 * request login is never the bed's owner, so the three profiles see the same
 * rules.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/user-tutorial-progress.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { createCheckedPool } from '../../../lambda/lib/db';
import { handler } from '../../../lambda/api/tutorial-progress';
import { apiEvent, fakePhone, parseResponse } from './r-paths-world';
import { describeInProfiles, loginClient, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

if (!databaseUrl) {
  test('CONCERN: the migration 130 DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const TABLE = 'public.user_tutorial_progress';
const SUB_PREFIX = 'tut127-';

interface Person {
  id: string;
  sub: string;
}

/** The SQLSTATE `promise` fails with, or null when it succeeds. */
async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

/** Runs `fn` on `login` in one transaction with the caller's sub set (when given); commits unless it throws. */
async function asLogin<T>(login: string, sub: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = loginClient(login);
  await client.connect();
  try {
    await client.query('BEGIN');
    if (sub) await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** The SQLSTATE one statement on jale_api fails with for `caller`, in a transaction of its own. */
function apiState(caller: Person, sql: string, params: unknown[] = []): Promise<string | null> {
  return sqlState(asLogin('jale_api', caller.sub, (c) => c.query(sql, params)));
}

describeInProfiles([...ALL_PROFILES], 'migration 130: user_tutorial_progress', () => {
  let su: Client;
  const placeholderIds: string[] = [];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    // Every account this suite made has a sub starting tut127-, or is a
    // placeholder whose id was kept; their progress rows go with them.
    try {
      await su.query(`DELETE FROM users WHERE cognito_sub LIKE '${SUB_PREFIX}%' OR id = ANY($1::uuid[])`, [placeholderIds]);
    } finally {
      await su.end();
    }
  });

  async function person(type: 'employer' | 'worker'): Promise<Person> {
    const id = randomUUID();
    const sub = `${SUB_PREFIX}${type}-${randomUUID()}`;
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type, full_name) VALUES ($1, $2, $3, $4)`,
      [id, sub, type, type === 'worker' ? 'Test Worker' : 'Test Employer'],
    );
    return { id, sub };
  }

  /** A row written past row security, for setting up a read. */
  async function seed(owner: Person, tutorialId: string, outcome = 'completed'): Promise<void> {
    await su.query(`INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, $2, $3)`, [owner.id, tutorialId, outcome]);
  }

  async function rowsOf(owner: { id: string }): Promise<Array<{ tutorial_id: string; outcome: string }>> {
    const { rows } = await su.query(
      `SELECT tutorial_id, outcome FROM ${TABLE} WHERE user_id = $1 ORDER BY tutorial_id`,
      [owner.id],
    );
    return rows;
  }

  describe('the catalog', () => {
    it('forces row security and gives jale_api SELECT and INSERT only, and no other login any right', async () => {
      const { rows: [rls] } = await su.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [TABLE],
      );
      expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const logins = Object.keys(loadManifest().logins).sort();
      expect(logins).toContain('jale_api');
      expect(logins).toContain('jale_whatsapp');
      const { rows } = await su.query(
        `SELECT l.login,
                has_table_privilege(l.login, $1, 'SELECT') AS sel,
                has_table_privilege(l.login, $1, 'INSERT') AS ins,
                has_table_privilege(l.login, $1, 'UPDATE') AS upd,
                has_table_privilege(l.login, $1, 'DELETE') AS del,
                has_table_privilege(l.login, $1, 'TRUNCATE') AS trunc,
                has_any_column_privilege(l.login, $1, 'UPDATE') AS col_upd
           FROM unnest($2::text[]) AS l(login)
          WHERE EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = l.login)
          ORDER BY l.login`,
        [TABLE, logins],
      );
      expect(rows.length).toBe(logins.length);
      for (const row of rows) {
        const reads = row.login === 'jale_api';
        expect(row).toEqual({ login: row.login, sel: reads, ins: reads, upd: false, del: false, trunc: false, col_upd: false });
      }
    });

    it('has exactly the two jale_api policies, with the expressions the access manifest records', async () => {
      // pg_get_expr qualifies names against the search_path; the manifest
      // records them as read with search_path = public.
      await su.query('BEGIN');
      try {
        await su.query(`SET LOCAL search_path = public`);
        const { rows } = await su.query(
          `SELECT policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
             FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_tutorial_progress'
            ORDER BY policyname`,
        );
        const policies = loadManifest().policies;
        expect(rows).toEqual([
          {
            policyname: 'user_tutorial_progress_self_insert',
            cmd: 'INSERT',
            permissive: 'PERMISSIVE',
            roles: ['jale_api'],
            qual: null,
            with_check: policies[`${TABLE}.user_tutorial_progress_self_insert`]?.with_check,
          },
          {
            policyname: 'user_tutorial_progress_self_read',
            cmd: 'SELECT',
            permissive: 'PERMISSIVE',
            roles: ['jale_api'],
            qual: policies[`${TABLE}.user_tutorial_progress_self_read`]?.using,
            with_check: null,
          },
        ]);
        expect(typeof rows[0].with_check).toBe('string');
        expect(rows[1].qual).toBe(rows[0].with_check);
      } finally {
        await su.query('ROLLBACK');
      }
    });
  });

  describe('the request login', () => {
    it("reads and inserts only the caller's own rows", async () => {
      const a = await person('employer');
      const b = await person('employer');
      await seed(b, 'employer_welcome', 'skipped');

      const seen = await asLogin('jale_api', a.sub, async (c) => {
        await c.query(`INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, 'employer_welcome', 'completed')`, [a.id]);
        return (await c.query(`SELECT user_id, tutorial_id, outcome FROM ${TABLE} ORDER BY user_id`)).rows;
      });

      expect(seen).toEqual([{ user_id: a.id, tutorial_id: 'employer_welcome', outcome: 'completed' }]);
      expect(await rowsOf(a)).toEqual([{ tutorial_id: 'employer_welcome', outcome: 'completed' }]);
      expect(await rowsOf(b)).toEqual([{ tutorial_id: 'employer_welcome', outcome: 'skipped' }]);
    });

    it('reads nothing and inserts nothing without a caller context', async () => {
      const a = await person('worker');
      await seed(a, 'worker_apply');

      const seen = await asLogin('jale_api', null, async (c) => (await c.query(`SELECT * FROM ${TABLE}`)).rows);
      expect(seen).toEqual([]);
      const insert = sqlState(asLogin('jale_api', null, (c) => c.query(
        `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, 'worker_profile', 'completed')`, [a.id],
      )));
      expect(await insert).toBe('42501');
      expect(await rowsOf(a)).toEqual([{ tutorial_id: 'worker_apply', outcome: 'completed' }]);
    });

    it('cannot insert a row for another account', async () => {
      const a = await person('worker');
      const b = await person('worker');

      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, 'worker_apply', 'completed')`, [b.id]))
        .toBe('42501');
      expect(await rowsOf(b)).toEqual([]);
    });

    it('cannot update, delete or truncate, even its own rows', async () => {
      const a = await person('employer');
      await seed(a, 'employer_messages', 'skipped');

      expect(await apiState(a, `UPDATE ${TABLE} SET outcome = 'completed' WHERE user_id = $1`, [a.id])).toBe('42501');
      expect(await apiState(a, `DELETE FROM ${TABLE} WHERE user_id = $1`, [a.id])).toBe('42501');
      expect(await apiState(a, `TRUNCATE ${TABLE}`)).toBe('42501');
      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, 'employer_messages', 'completed')
                                ON CONFLICT (user_id, tutorial_id) DO UPDATE SET outcome = EXCLUDED.outcome`, [a.id]))
        .toBe('42501');
      expect(await rowsOf(a)).toEqual([{ tutorial_id: 'employer_messages', outcome: 'skipped' }]);
    });

    it.each([
      ['no role prefix', 'tutorial_welcome'],
      ['an admin prefix', 'admin_welcome'],
      ['nothing after the prefix', 'employer_'],
      ['an upper-case letter', 'Employer_welcome'],
      ['a digit', 'worker_apply2'],
      ['a dash', 'worker_apply-now'],
      ['more than 40 characters after the prefix', `worker_${'a'.repeat(41)}`],
    ])('refuses an id with %s (CHECK)', async (_name, tutorialId) => {
      const a = await person('worker');
      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, $2, 'completed')`, [a.id, tutorialId]))
        .toBe('23514');
      expect(await rowsOf(a)).toEqual([]);
    });

    it('refuses an unknown outcome (CHECK), and takes any id of the right shape', async () => {
      const a = await person('employer');
      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, 'employer_welcome', 'dismissed')`, [a.id]))
        .toBe('23514');
      // The shape only: the API holds the exact list, so a later id needs no migration.
      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, tutorial_id, outcome) VALUES ($1, $2, 'skipped')`, [a.id, `employer_${'z'.repeat(40)}`]))
        .toBeNull();
      expect(await rowsOf(a)).toEqual([{ tutorial_id: `employer_${'z'.repeat(40)}`, outcome: 'skipped' }]);
    });
  });

  describe('rows leave with their account', () => {
    it('deleting the users row as the database owner removes its progress rows and no other', async () => {
      const a = await person('worker');
      const b = await person('worker');
      await seed(a, 'worker_onboarding');
      await seed(a, 'worker_apply', 'skipped');
      await seed(b, 'worker_onboarding');

      const deleted = await su.query(`DELETE FROM users WHERE id = $1`, [a.id]);

      expect(deleted.rowCount).toBe(1);
      expect(await rowsOf(a)).toEqual([]);
      expect(await rowsOf(b)).toEqual([{ tutorial_id: 'worker_onboarding', outcome: 'completed' }]);
    });

    it("the WhatsApp reconcile's placeholder delete still works on jale_whatsapp and leaves the web account's rows alone", async () => {
      // A worker who signed up on the web and recorded progress there, and
      // the phone-keyed placeholder users row an earlier WhatsApp message
      // left (cognito_sub = phone, whatsapp_number not yet set).
      const web = await person('worker');
      await seed(web, 'worker_onboarding');
      await seed(web, 'worker_profile', 'skipped');
      const phone = fakePhone();
      const placeholderId = randomUUID();
      placeholderIds.push(placeholderId);
      await su.query(
        `INSERT INTO users (id, cognito_sub, user_type, phone) VALUES ($1, $2, 'worker', $2)`,
        [placeholderId, phone],
      );
      // A placeholder never signs in on the web, so it owns no progress rows.
      // One is written here anyway, past row security, to show the cascade
      // runs on this path without the WhatsApp login holding any right on the
      // table.
      await seed({ id: placeholderId, sub: phone }, 'worker_apply');
      const { rows: [rights] } = await su.query(
        `SELECT has_any_column_privilege('jale_whatsapp', $1, 'SELECT') AS sel,
                has_any_column_privilege('jale_whatsapp', $1, 'INSERT') AS ins,
                has_table_privilege('jale_whatsapp', $1, 'DELETE') AS del`,
        [TABLE],
      );
      expect(rights).toEqual({ sel: false, ins: false, del: false });

      // processor.ts reconcileUserRow, Case B: the same statement and predicate.
      const deleted = await asLogin('jale_whatsapp', null, (c) => c.query(
        `DELETE FROM users
          WHERE cognito_sub = $1
            AND user_type = 'worker'
            AND cognito_sub <> $2`,
        [phone, web.sub],
      ));

      expect(deleted.rowCount).toBe(1);
      expect((await su.query(`SELECT 1 FROM users WHERE id = $1`, [placeholderId])).rowCount).toBe(0);
      expect(await rowsOf({ id: placeholderId })).toEqual([]);
      expect((await su.query(`SELECT 1 FROM users WHERE id = $1`, [web.id])).rowCount).toBe(1);
      expect(await rowsOf(web)).toEqual([
        { tutorial_id: 'worker_onboarding', outcome: 'completed' },
        { tutorial_id: 'worker_profile', outcome: 'skipped' },
      ]);
    });
  });

  describe('the handler on jale_api', () => {
    beforeAll(async () => {
      mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 2 }, 'jale_api', 'test');
    });
    afterAll(async () => {
      await mockPool?.end();
      mockPool = undefined;
    });

    const call = async (resource: string, sub: string, httpMethod: 'GET' | 'POST', body?: unknown) =>
      parseResponse(await handler(apiEvent({ resource, httpMethod, sub, body })));

    it('answers the empty list, keeps the first outcome, and reads it back with the stored time', async () => {
      const a = await person('employer');

      expect(await call('/employer/tutorials', a.sub, 'GET'))
        .toEqual({ statusCode: 200, body: { tutorials: [], settings: { always_show: false, muted: [] } } });
      const first = await call('/employer/tutorials', a.sub, 'POST', { tutorial_id: 'employer_welcome', outcome: 'skipped' });
      const second = await call('/employer/tutorials', a.sub, 'POST', { tutorial_id: 'employer_welcome', outcome: 'completed' });
      const read = await call('/employer/tutorials', a.sub, 'GET');

      const { rows: [row] } = await su.query(
        `SELECT outcome, recorded_at FROM ${TABLE} WHERE user_id = $1 AND tutorial_id = 'employer_welcome'`, [a.id],
      );
      const stored = { tutorial_id: 'employer_welcome', outcome: 'skipped', recorded_at: (row.recorded_at as Date).toISOString() };
      expect(first).toEqual({ statusCode: 200, body: { tutorial: stored } });
      expect(second).toEqual({ statusCode: 200, body: { tutorial: stored } });
      expect(read).toEqual({ statusCode: 200, body: { tutorials: [stored], settings: { always_show: false, muted: [] } } });
      expect(await rowsOf(a)).toEqual([{ tutorial_id: 'employer_welcome', outcome: 'skipped' }]);
    });

    it("answers the path's role only: a stray row of the other role is never returned", async () => {
      const w = await person('worker');
      await seed(w, 'employer_welcome');

      expect((await call('/worker/tutorials', w.sub, 'POST', { tutorial_id: 'worker_onboarding', outcome: 'completed' })).statusCode)
        .toBe(200);
      const read = await call('/worker/tutorials', w.sub, 'GET');

      expect(read.statusCode).toBe(200);
      expect(read.body.tutorials.map((t: { tutorial_id: string }) => t.tutorial_id)).toEqual(['worker_onboarding']);
      expect(await call('/worker/tutorials', w.sub, 'POST', { tutorial_id: 'employer_welcome', outcome: 'completed' }))
        .toEqual({ statusCode: 400, body: { error: 'invalid_tutorial' } });
    });

    it('answers 404 not_found for a caller with no users row, and writes nothing', async () => {
      const sub = `${SUB_PREFIX}missing-${randomUUID()}`;

      expect(await call('/worker/tutorials', sub, 'GET')).toEqual({ statusCode: 404, body: { error: 'not_found' } });
      expect(await call('/worker/tutorials', sub, 'POST', { tutorial_id: 'worker_apply', outcome: 'completed' }))
        .toEqual({ statusCode: 404, body: { error: 'not_found' } });
    });

    it('stores one row when two records for the same id arrive together, and both answer it', async () => {
      const a = await person('worker');

      const [one, two] = await Promise.all([
        call('/worker/tutorials', a.sub, 'POST', { tutorial_id: 'worker_details', outcome: 'completed' }),
        call('/worker/tutorials', a.sub, 'POST', { tutorial_id: 'worker_details', outcome: 'skipped' }),
      ]);

      expect(one.statusCode).toBe(200);
      expect(two).toEqual(one);
      const rows = await rowsOf(a);
      expect(rows).toHaveLength(1);
      expect(one.body.tutorial.outcome).toBe(rows[0].outcome);
    });
  });
});
