/**
 * user-tutorial-settings.integration.test.ts
 *
 * Migration 137 (guide settings, contract K1-v2) on a real PostgreSQL 16
 * bed, through the real logins:
 *
 *   - the request login (jale_api) reads, inserts and updates the caller's
 *     own row only, with the caller context the handlers set; it cannot
 *     write a row for another account or move its row to one, and it holds
 *     no DELETE or TRUNCATE;
 *   - row security is forced and the policies are the ones the access
 *     manifest records;
 *   - the list CHECK refuses an id of the wrong shape, a NULL element, an
 *     element that holds a comma or is empty, a second dimension and more
 *     than 16 elements;
 *   - a row leaves with its users row (ON DELETE CASCADE), including on the
 *     WhatsApp sign-in reconcile, whose placeholder delete
 *     (lambda/whatsapp/processor.ts, reconcileUserRow) keeps working on
 *     jale_whatsapp;
 *   - the handler (lambda/api/tutorial-progress.ts) on jale_api: the
 *     defaults with no row, the upsert keeping a field that is left out, the
 *     role's ids only, and the app tour recorded like a tutorial.
 *
 * Fixtures and every read that decides an assertion go through the
 * superuser URL; code under test runs on its own login (login-pool.ts). The
 * request login is never the bed's owner, so the three profiles see the same
 * rules.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/user-tutorial-settings.integration.test.ts
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
  test('CONCERN: the migration 137 DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const TABLE = 'public.user_tutorial_settings';
const SUB_PREFIX = 'tutset137-';
// The handler's upsert, as lambda/api/tutorial-progress.ts runs it.
const UPSERT = `INSERT INTO user_tutorial_settings (user_id, always_show, muted, updated_at)
                VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text[], '{}'), now())
                ON CONFLICT (user_id) DO UPDATE
                   SET always_show = COALESCE($2::boolean, user_tutorial_settings.always_show),
                       muted = COALESCE($3::text[], user_tutorial_settings.muted),
                       updated_at = now()
                RETURNING always_show, muted`;

interface Person {
  id: string;
  sub: string;
}

interface SettingsRow {
  always_show: boolean;
  muted: string[];
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

describeInProfiles([...ALL_PROFILES], 'migration 137: user_tutorial_settings', () => {
  let su: Client;
  const placeholderIds: string[] = [];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    // Every account this suite made has a sub starting tutset137-, or is a
    // placeholder whose id was kept; their settings and progress rows go
    // with them.
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
  async function seed(owner: { id: string }, alwaysShow: boolean, muted: string[]): Promise<void> {
    await su.query(`INSERT INTO ${TABLE} (user_id, always_show, muted) VALUES ($1, $2, $3)`, [owner.id, alwaysShow, muted]);
  }

  async function rowOf(owner: { id: string }): Promise<SettingsRow | null> {
    const { rows } = await su.query(`SELECT always_show, muted FROM ${TABLE} WHERE user_id = $1`, [owner.id]);
    return rows[0] ?? null;
  }

  describe('the catalog', () => {
    it('forces row security and gives jale_api SELECT, INSERT and UPDATE only, and no other login any right', async () => {
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
                has_any_column_privilege(l.login, $1, 'SELECT') AS col_sel
           FROM unnest($2::text[]) AS l(login)
          WHERE EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = l.login)
          ORDER BY l.login`,
        [TABLE, logins],
      );
      expect(rows.length).toBe(logins.length);
      for (const row of rows) {
        const api = row.login === 'jale_api';
        expect(row).toEqual({ login: row.login, sel: api, ins: api, upd: api, del: false, trunc: false, col_sel: api });
      }
    });

    it('has exactly the three jale_api policies, with the expressions the access manifest records', async () => {
      // pg_get_expr qualifies names against the search_path; the manifest
      // records them as read with search_path = public.
      await su.query('BEGIN');
      try {
        await su.query(`SET LOCAL search_path = public`);
        const { rows } = await su.query(
          `SELECT policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
             FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_tutorial_settings'
            ORDER BY policyname`,
        );
        const policies = loadManifest().policies;
        const entry = (name: string) => policies[`${TABLE}.${name}`];
        expect(rows).toEqual([
          {
            policyname: 'user_tutorial_settings_self_insert',
            cmd: 'INSERT',
            permissive: 'PERMISSIVE',
            roles: ['jale_api'],
            qual: null,
            with_check: entry('user_tutorial_settings_self_insert')?.with_check,
          },
          {
            policyname: 'user_tutorial_settings_self_read',
            cmd: 'SELECT',
            permissive: 'PERMISSIVE',
            roles: ['jale_api'],
            qual: entry('user_tutorial_settings_self_read')?.using,
            with_check: null,
          },
          {
            policyname: 'user_tutorial_settings_self_update',
            cmd: 'UPDATE',
            permissive: 'PERMISSIVE',
            roles: ['jale_api'],
            qual: entry('user_tutorial_settings_self_update')?.using,
            with_check: entry('user_tutorial_settings_self_update')?.with_check,
          },
        ]);
        // One predicate throughout, and the same one 130's policies use.
        expect(typeof rows[0].with_check).toBe('string');
        expect(new Set([rows[0].with_check, rows[1].qual, rows[2].qual, rows[2].with_check]).size).toBe(1);
        const { rows: [progress] } = await su.query(
          `SELECT qual FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'user_tutorial_progress' AND policyname = 'user_tutorial_progress_self_read'`,
        );
        expect(progress.qual).toBe(rows[1].qual);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('has the column defaults the handler relies on', async () => {
      const a = await person('employer');
      await su.query(`INSERT INTO ${TABLE} (user_id) VALUES ($1)`, [a.id]);
      const { rows: [row] } = await su.query(
        `SELECT always_show, muted, updated_at > now() - interval '1 minute' AS fresh FROM ${TABLE} WHERE user_id = $1`, [a.id],
      );
      expect(row).toEqual({ always_show: false, muted: [], fresh: true });
    });
  });

  describe('the request login', () => {
    it("reads only the caller's own row", async () => {
      const a = await person('employer');
      const b = await person('employer');
      await seed(a, true, ['employer_welcome']);
      await seed(b, false, ['employer_post_job']);

      const seen = await asLogin('jale_api', a.sub, async (c) => (await c.query(`SELECT user_id, always_show, muted FROM ${TABLE}`)).rows);

      expect(seen).toEqual([{ user_id: a.id, always_show: true, muted: ['employer_welcome'] }]);
    });

    it('reads nothing, inserts nothing and updates nothing without a caller context', async () => {
      const a = await person('worker');
      await seed(a, false, []);

      expect(await asLogin('jale_api', null, async (c) => (await c.query(`SELECT * FROM ${TABLE}`)).rows)).toEqual([]);
      const b = await person('worker');
      expect(await sqlState(asLogin('jale_api', null, (c) => c.query(
        `INSERT INTO ${TABLE} (user_id, always_show) VALUES ($1, true)`, [b.id],
      )))).toBe('42501');
      const updated = await asLogin('jale_api', null, (c) => c.query(`UPDATE ${TABLE} SET always_show = true WHERE user_id = $1`, [a.id]));
      expect(updated.rowCount).toBe(0);
      expect(await rowOf(a)).toEqual({ always_show: false, muted: [] });
      expect(await rowOf(b)).toBeNull();
    });

    it('inserts and updates its own row', async () => {
      const a = await person('worker');

      await asLogin('jale_api', a.sub, (c) => c.query(`INSERT INTO ${TABLE} (user_id, muted) VALUES ($1, '{worker_apply}')`, [a.id]));
      const updated = await asLogin('jale_api', a.sub, (c) => c.query(
        `UPDATE ${TABLE} SET always_show = true, muted = '{worker_apply,worker_profile}', updated_at = now() WHERE user_id = $1`, [a.id],
      ));

      expect(updated.rowCount).toBe(1);
      expect(await rowOf(a)).toEqual({ always_show: true, muted: ['worker_apply', 'worker_profile'] });
    });

    it("cannot insert a row for another account, update another account's row, or move its own row", async () => {
      const a = await person('employer');
      const b = await person('employer');
      const c = await person('employer');
      await seed(a, false, []);
      await seed(b, false, ['employer_messages']);

      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, always_show) VALUES ($1, true)`, [c.id])).toBe('42501');
      const other = await asLogin('jale_api', a.sub, (cl) => cl.query(`UPDATE ${TABLE} SET always_show = true WHERE user_id = $1`, [b.id]));
      expect(other.rowCount).toBe(0);
      expect(await apiState(a, `UPDATE ${TABLE} SET user_id = $2 WHERE user_id = $1`, [a.id, c.id])).toBe('42501');
      // An upsert that lands on another account's row is refused, not merged.
      expect(await apiState(a, UPSERT, [b.id, true, null])).toBe('42501');

      expect(await rowOf(a)).toEqual({ always_show: false, muted: [] });
      expect(await rowOf(b)).toEqual({ always_show: false, muted: ['employer_messages'] });
      expect(await rowOf(c)).toBeNull();
    });

    it('cannot delete or truncate, even its own row', async () => {
      const a = await person('worker');
      await seed(a, true, ['worker_details']);

      expect(await apiState(a, `DELETE FROM ${TABLE} WHERE user_id = $1`, [a.id])).toBe('42501');
      expect(await apiState(a, `TRUNCATE ${TABLE}`)).toBe('42501');
      expect(await rowOf(a)).toEqual({ always_show: true, muted: ['worker_details'] });
    });

    it("runs the handler's upsert: the first write takes the defaults, a NULL field keeps the stored value", async () => {
      const a = await person('employer');

      const first = await asLogin('jale_api', a.sub, (c) => c.query(UPSERT, [a.id, true, null]));
      expect(first.rows).toEqual([{ always_show: true, muted: [] }]);
      const second = await asLogin('jale_api', a.sub, (c) => c.query(UPSERT, [a.id, null, ['employer_welcome', 'employer_messages']]));
      expect(second.rows).toEqual([{ always_show: true, muted: ['employer_welcome', 'employer_messages'] }]);
      const cleared = await asLogin('jale_api', a.sub, (c) => c.query(UPSERT, [a.id, false, []]));
      expect(cleared.rows).toEqual([{ always_show: false, muted: [] }]);
      expect(await rowOf(a)).toEqual({ always_show: false, muted: [] });
    });
  });

  describe('the list CHECK', () => {
    const shape = (n: number) => Array.from({ length: n }, (_, i) => `employer_${'abcdefghijklmnopq'.slice(0, i + 1)}`);

    it.each([
      ['no role prefix', '{tutorial_welcome}'],
      ['an admin prefix', '{admin_welcome}'],
      ['nothing after the prefix', '{employer_}'],
      ['an upper-case letter', '{Employer_welcome}'],
      ['a digit', '{worker_apply2}'],
      ['a dash', '{worker_apply-now}'],
      ['more than 40 characters after the prefix', `{worker_${'a'.repeat(41)}}`],
      ['one good id and one bad', '{employer_welcome,employer_Welcome}'],
      ['a NULL element', '{NULL}'],
      ['a NULL among good ids', '{employer_welcome,NULL,employer_messages}'],
      ['an element that holds a comma', '{"employer_welcome,worker_apply"}'],
      ['an empty element', '{""}'],
      ['an empty element among good ids', '{employer_welcome,""}'],
      ['a second dimension', '{{employer_welcome,employer_messages}}'],
      ['17 elements', `{${shape(17).join(',')}}`],
    ])('refuses %s (23514)', async (_name, literal) => {
      const a = await person('employer');
      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, muted) VALUES ($1, $2::text[])`, [a.id, literal])).toBe('23514');
      await seed(a, false, []);
      expect(await apiState(a, `UPDATE ${TABLE} SET muted = $2::text[] WHERE user_id = $1`, [a.id, literal])).toBe('23514');
      expect(await rowOf(a)).toEqual({ always_show: false, muted: [] });
    });

    it('takes an empty list, 16 ids, and any id of the right shape', async () => {
      const a = await person('employer');
      const b = await person('worker');
      const c = await person('worker');

      expect(await apiState(a, `INSERT INTO ${TABLE} (user_id, muted) VALUES ($1, '{}')`, [a.id])).toBeNull();
      expect(await apiState(b, `INSERT INTO ${TABLE} (user_id, muted) VALUES ($1, $2::text[])`, [b.id, shape(16)])).toBeNull();
      // The shape only: the API holds the exact list, so a later id needs no migration.
      const later = [`worker_${'z'.repeat(40)}`, 'employer_welcome'];
      expect(await apiState(c, `INSERT INTO ${TABLE} (user_id, muted) VALUES ($1, $2::text[])`, [c.id, later])).toBeNull();

      expect(await rowOf(a)).toEqual({ always_show: false, muted: [] });
      expect((await rowOf(b))?.muted).toEqual(shape(16));
      expect((await rowOf(c))?.muted).toEqual(later);
    });
  });

  describe('rows leave with their account', () => {
    it('deleting the users row as the database owner removes its settings row and no other', async () => {
      const a = await person('worker');
      const b = await person('worker');
      await seed(a, true, ['worker_onboarding']);
      await seed(b, false, ['worker_apply']);

      const deleted = await su.query(`DELETE FROM users WHERE id = $1`, [a.id]);

      expect(deleted.rowCount).toBe(1);
      expect(await rowOf(a)).toBeNull();
      expect(await rowOf(b)).toEqual({ always_show: false, muted: ['worker_apply'] });
    });

    it("the WhatsApp reconcile's placeholder delete still works on jale_whatsapp and leaves the web account's row alone", async () => {
      // A worker who signed up on the web and saved settings there, and the
      // phone-keyed placeholder users row an earlier WhatsApp message left
      // (cognito_sub = phone, whatsapp_number not yet set).
      const web = await person('worker');
      await seed(web, true, ['worker_profile']);
      const phone = fakePhone();
      const placeholderId = randomUUID();
      placeholderIds.push(placeholderId);
      await su.query(
        `INSERT INTO users (id, cognito_sub, user_type, phone) VALUES ($1, $2, 'worker', $2)`,
        [placeholderId, phone],
      );
      // A placeholder never signs in on the web, so it owns no settings row.
      // One is written here anyway, past row security, to show the cascade
      // runs on this path without the WhatsApp login holding any right on the
      // table.
      await seed({ id: placeholderId }, true, []);
      const { rows: [rights] } = await su.query(
        `SELECT has_any_column_privilege('jale_whatsapp', $1, 'SELECT') AS sel,
                has_any_column_privilege('jale_whatsapp', $1, 'UPDATE') AS upd,
                has_table_privilege('jale_whatsapp', $1, 'DELETE') AS del`,
        [TABLE],
      );
      expect(rights).toEqual({ sel: false, upd: false, del: false });

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
      expect(await rowOf({ id: placeholderId })).toBeNull();
      expect(await rowOf(web)).toEqual({ always_show: true, muted: ['worker_profile'] });
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

    const call = async (resource: string, sub: string, httpMethod: 'GET' | 'POST' | 'PATCH', body?: unknown) =>
      parseResponse(await handler(apiEvent({ resource, httpMethod, sub, body })));

    it('answers the defaults with no row, saves each field on its own, and reads the stored row back', async () => {
      const a = await person('employer');

      expect(await call('/employer/tutorials', a.sub, 'GET'))
        .toEqual({ statusCode: 200, body: { tutorials: [], settings: { always_show: false, muted: [] } } });
      expect(await rowOf(a)).toBeNull();

      expect(await call('/employer/tutorials', a.sub, 'PATCH', { always_show: true }))
        .toEqual({ statusCode: 200, body: { settings: { always_show: true, muted: [] } } });
      expect(await call('/employer/tutorials', a.sub, 'PATCH', { muted: ['employer_messages', 'employer_welcome', 'employer_messages'] }))
        .toEqual({ statusCode: 200, body: { settings: { always_show: true, muted: ['employer_welcome', 'employer_messages'] } } });
      expect(await rowOf(a)).toEqual({ always_show: true, muted: ['employer_welcome', 'employer_messages'] });

      expect(await call('/employer/tutorials', a.sub, 'PATCH', { always_show: false, muted: [] }))
        .toEqual({ statusCode: 200, body: { settings: { always_show: false, muted: [] } } });
      expect(await call('/employer/tutorials', a.sub, 'GET'))
        .toEqual({ statusCode: 200, body: { tutorials: [], settings: { always_show: false, muted: [] } } });

      const { rows: [row] } = await su.query(
        `SELECT updated_at > now() - interval '1 minute' AS fresh FROM ${TABLE} WHERE user_id = $1`, [a.id],
      );
      expect(row.fresh).toBe(true);
    });

    it("answers muted filtered to the path's role, in its list order", async () => {
      const w = await person('worker');
      await seed(w, false, ['worker_profile', 'employer_welcome', 'worker_app_tour', 'worker_onboarding']);

      expect((await call('/worker/tutorials', w.sub, 'GET')).body.settings)
        .toEqual({ always_show: false, muted: ['worker_onboarding', 'worker_profile'] });
    });

    it('refuses a tour id or the other role\'s id in muted, and writes nothing', async () => {
      const w = await person('worker');

      for (const muted of [['worker_app_tour'], ['employer_welcome'], ['worker_apply', 7]]) {
        expect(await call('/worker/tutorials', w.sub, 'PATCH', { muted }))
          .toEqual({ statusCode: 400, body: { error: 'invalid_settings' } });
      }
      expect(await call('/worker/tutorials', w.sub, 'PATCH', {}))
        .toEqual({ statusCode: 400, body: { error: 'invalid_settings' } });
      expect(await rowOf(w)).toBeNull();
    });

    it("records the role's app tour like a tutorial and answers it on GET, and refuses the other role's", async () => {
      const w = await person('worker');

      const first = await call('/worker/tutorials', w.sub, 'POST', { tutorial_id: 'worker_app_tour', outcome: 'skipped' });
      const second = await call('/worker/tutorials', w.sub, 'POST', { tutorial_id: 'worker_app_tour', outcome: 'completed' });
      expect(first.statusCode).toBe(200);
      expect(first.body.tutorial).toEqual(expect.objectContaining({ tutorial_id: 'worker_app_tour', outcome: 'skipped' }));
      expect(second).toEqual(first);
      expect(await call('/worker/tutorials', w.sub, 'POST', { tutorial_id: 'employer_app_tour', outcome: 'completed' }))
        .toEqual({ statusCode: 400, body: { error: 'invalid_tutorial' } });

      const read = await call('/worker/tutorials', w.sub, 'GET');
      expect(read).toEqual({ statusCode: 200, body: { tutorials: [first.body.tutorial], settings: { always_show: false, muted: [] } } });
    });

    it('answers 404 not_found for a caller with no users row, and writes nothing', async () => {
      const sub = `${SUB_PREFIX}missing-${randomUUID()}`;
      const count = async () => (await su.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
      const before = await count();

      expect(await call('/employer/tutorials', sub, 'PATCH', { always_show: true }))
        .toEqual({ statusCode: 404, body: { error: 'not_found' } });
      expect(await call('/employer/tutorials', sub, 'GET'))
        .toEqual({ statusCode: 404, body: { error: 'not_found' } });
      expect(await count()).toBe(before);
    });

    it('two saves at once leave one row, holding one of the two writes', async () => {
      const a = await person('worker');

      const [one, two] = await Promise.all([
        call('/worker/tutorials', a.sub, 'PATCH', { always_show: true, muted: ['worker_apply'] }),
        call('/worker/tutorials', a.sub, 'PATCH', { always_show: false, muted: ['worker_details'] }),
      ]);

      expect(one.statusCode).toBe(200);
      expect(two.statusCode).toBe(200);
      const row = await rowOf(a);
      expect([one.body.settings, two.body.settings]).toContainEqual(row);
      expect((await su.query(`SELECT 1 FROM ${TABLE} WHERE user_id = $1`, [a.id])).rowCount).toBe(1);
    });
  });
});
