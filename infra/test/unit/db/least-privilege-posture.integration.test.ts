/**
 * least-privilege-posture.integration.test.ts -- login posture on a real bed.
 *
 * Proves, over real authenticated connections (never SET ROLE), that every
 * runtime login in the access manifest signs in as itself and that row-level
 * security is active for it, using the OID form of the boot identity probe
 * the pool getters run:
 *
 *   SELECT row_security_active(c.oid) FROM pg_class c JOIN pg_namespace n ...
 *    WHERE n.nspname = 'public' AND c.relname = 'users'
 *
 * The OID form needs no privilege on the table and no USAGE on the schema, so
 * it answers for a login that holds no grant on `users` at all.
 *
 * It also smoke-tests the test-bed profiles (bootstrap-testbed.sh --profile):
 *   standard / request  the bed as the migration chain leaves it.
 *   owner-unrestricted  handlers' own SQL scoping is exercised without
 *                       depending on row policies.
 *
 * And it runs the posture check itself (infra/db/access/posture.ts) as the
 * catalog-only posture login, the way the scheduled check does:
 *   - complete and clean on a correct bed;
 *   - each injected fault named: a login given BYPASSRLS, a login made a
 *     member of a role, FORCE removed from a table, a definer opened to
 *     PUBLIC, an INHERIT membership in a capability owner, a right held WITH
 *     GRANT OPTION, a view, the operator group's own membership, privilege
 *     or attribute, and a runtime login's role setting (named by the
 *     setting only, never its value);
 *   - a personal operator login in the one accepted shape is clean, any
 *     other unlisted login is named;
 *   - objects a manifest.d fragment declares keep the run complete and
 *     clean, and are named when no fragment declares them;
 *   - an unreachable or incomplete catalog read gives complete = false.
 * Faults and fixture objects are committed (the posture login reads over its
 * own connection), then reverted or dropped in `finally`; the DB runner runs
 * suites one at a time, so no other suite sees them.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL); the logins
 * sign in with the bed's fixed test passwords through helpers/login-pool.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from 'pg';
import { loadManifest, runtimeLogins, type AccessManifest } from '../../../db/access/access-manifest';
import {
  checkPosture, readPostureRows, type PostureExtension, type PostureQueryable, type PostureResult, type PostureViolation,
} from '../../../db/access/posture';
import { createPostureCheckHandler, type PostureConnection } from '../../../lambda/ops/db-posture-check';
import { currentDbProfile, loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege posture PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-posture] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const RLS_PROBE = `
  SELECT pg_catalog.row_security_active(c.oid) AS active
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'users'`;

maybeDescribe('least-privilege posture: logins and test-bed profiles', () => {
  const manifest = loadManifest();
  const profile = currentDbProfile();
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su?.end();
  });

  describe('profiles', () => {
    it('the bed carries the profile JALE_TEST_DB_PROFILE names', async () => {
      const { rows } = await su.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1',
        [manifest.master],
      );
      const unrestricted = rows[0]?.rolbypassrls;
      expect({ profile, unrestricted })
        .toEqual({ profile, unrestricted: profile === 'owner-unrestricted' });
    });

    it('the bootstrap owner login signs in, and the probe reports row security for it per profile', async () => {
      const result = await withLoginClient(manifest.master, async (c) =>
        (await c.query<{ who: string; active: boolean }>(`SELECT current_user AS who, (${RLS_PROBE}) AS active`)).rows[0]);
      expect(result).toEqual({ who: manifest.master, active: profile !== 'owner-unrestricted' });
    });
  });

  describe('runtime logins', () => {
    it.each(runtimeLogins(loadManifest()))('%s signs in as itself with row security active', async (login) => {
      const result = await withLoginClient(login, async (c) =>
        (await c.query<{ who: string; session: string; active: boolean }>(
          `SELECT current_user AS who, session_user AS session, (${RLS_PROBE}) AS active`,
        )).rows[0]);
      expect(result).toEqual({ who: login, session: login, active: true });
    });
  });
});

const shippedAccessDir = path.join(__dirname, '..', '..', '..', 'db', 'access');

/** The posture check as the scheduled check runs it: signed in as the posture login. */
function postureAs(manifest: AccessManifest, extensions?: ReadonlyArray<PostureExtension<unknown>>): Promise<PostureResult> {
  return withLoginClient('jale_posture', (client) => checkPosture(client, manifest, extensions));
}

maybeDescribe('least-privilege posture: the posture check as the posture login', () => {
  const manifest = loadManifest();
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });

  afterAll(async () => {
    await su?.end();
  });

  /** Commits `apply`, runs the check, always commits `revert`, and returns the run. */
  async function withFault(apply: string[], revert: string[]): Promise<PostureResult> {
    try {
      for (const sql of apply) await su.query(sql);
      return await postureAs(manifest);
    } finally {
      for (const sql of revert) await su.query(sql);
    }
  }

  it('is complete and clean on this bed, and records the server version', async () => {
    const result = await postureAs(manifest);
    expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
    expect(result.serverVersion).toMatch(/^16\./);
  });

  const definer = Object.entries(loadManifest().functions).find(([, f]) => f.security === 'definer' && f.owner === 'jale_admin')![0];
  const definerSql = (() => {
    const open = definer.indexOf('(');
    return `${definer.slice(0, open)}(${definer.slice(open + 1, -1)})`;
  })();
  const FAULTS: Array<[string, string[], string[], PostureViolation]> = [
    ['a login given BYPASSRLS', ['ALTER ROLE jale_api BYPASSRLS'], ['ALTER ROLE jale_api NOBYPASSRLS'],
      { check: 'login_attributes', object: 'jale_api', detail: 'carries BYPASSRLS' }],
    // A membership in the master itself cannot be created: the master holds
    // the creator's ADMIN membership in every login it created, and
    // PostgreSQL refuses a circular grant. The check is the same for any role.
    ['a login made a member of a role', ['GRANT pg_read_all_data TO jale_api'], ['REVOKE pg_read_all_data FROM jale_api'],
      { check: 'login_memberships', object: 'jale_api', detail: 'member of pg_read_all_data' }],
    ['FORCE removed from a table', ['ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY'],
      ['ALTER TABLE public.users FORCE ROW LEVEL SECURITY'],
      { check: 'table_rls', object: 'public.users', detail: 'FORCE ROW LEVEL SECURITY is off; the manifest says on' }],
    ['a definer opened to PUBLIC', [`GRANT EXECUTE ON FUNCTION ${definerSql} TO PUBLIC`],
      [`REVOKE EXECUTE ON FUNCTION ${definerSql} FROM PUBLIC`],
      { check: 'definer_public_execute', object: definer, detail: 'executable by PUBLIC' }],
    ['an INHERIT membership in a capability owner', ['GRANT jale_cap_retention TO jale_ops_readonly WITH INHERIT TRUE, SET FALSE'],
      ['REVOKE jale_cap_retention FROM jale_ops_readonly'],
      { check: 'capability_owner_memberships', object: 'jale_cap_retention', detail: 'jale_ops_readonly holds INHERIT' }],
    ['TEMPORARY granted on the database to a login',
      [`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO jale_api', current_database()); END $$`],
      [`DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM jale_api', current_database()); END $$`],
      { check: 'login_temp', object: 'jale_api', detail: 'holds TEMPORARY on the database' }],
    ['a table opened to PUBLIC', ['GRANT SELECT ON public.document_upload_tokens TO PUBLIC'],
      ['REVOKE SELECT ON public.document_upload_tokens FROM PUBLIC'],
      { check: 'manifest_drift', object: 'public.document_upload_tokens', detail: 'check 2: PUBLIC holds SELECT' }],
    ['an extra right on a capability owner', ['GRANT SELECT (title) ON public.jobs TO jale_cap_share_links'],
      ['REVOKE SELECT (title) ON public.jobs FROM jale_cap_share_links'],
      { check: 'manifest_drift', object: 'public.jobs', detail: 'check 9: jale_cap_share_links holds SELECT (title); the manifest does not list it' }],
    ['a capability owner\'s policy widened', ['ALTER POLICY users_cap_worker_lane_select ON public.users USING (true)'],
      [`ALTER POLICY users_cap_worker_lane_select ON public.users
          USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), id))`],
      { check: 'manifest_drift', object: 'public.users.users_cap_worker_lane_select', detail: 'check 9: USING differs from the manifest' }],
    ['a job login\'s new policy widened', ['ALTER POLICY email_outbox_digest_select ON public.email_outbox USING (true)'],
      [`ALTER POLICY email_outbox_digest_select ON public.email_outbox USING (source_type = 'employer_digest')`],
      { check: 'manifest_drift', object: 'public.email_outbox.email_outbox_digest_select', detail: 'check 2: USING differs from the manifest' }],
    ['CREATE on the database for a login',
      [`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO jale_api', current_database()); END $$`],
      [`DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM jale_api', current_database()); END $$`],
      { check: 'database_create', object: 'jale_api', detail: 'holds CREATE on the database' }],
    ['CREATE on schema public for PUBLIC', ['GRANT CREATE ON SCHEMA public TO PUBLIC'], ['REVOKE CREATE ON SCHEMA public FROM PUBLIC'],
      { check: 'public_schema_create', object: 'PUBLIC', detail: 'holds CREATE on schema public' }],
    ['new functions reopened to PUBLIC', ['ALTER DEFAULT PRIVILEGES FOR ROLE jale_admin GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
      ['ALTER DEFAULT PRIVILEGES FOR ROLE jale_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'],
      { check: 'default_public_execute', object: 'jale_admin', detail: 'functions it creates are executable by PUBLIC' }],
    ['a capability owner given BYPASSRLS', ['ALTER ROLE jale_cap_worker_lane BYPASSRLS'], ['ALTER ROLE jale_cap_worker_lane NOBYPASSRLS'],
      { check: 'owner_attributes', object: 'jale_cap_worker_lane', detail: 'carries BYPASSRLS' }],
    ['a helper role given BYPASSRLS', ['ALTER ROLE jale_rls_relationship_reader BYPASSRLS'], ['ALTER ROLE jale_rls_relationship_reader NOBYPASSRLS'],
      { check: 'owner_attributes', object: 'jale_rls_relationship_reader', detail: 'carries BYPASSRLS' }],
    ['a capability owner made a member of a role', ['GRANT pg_read_all_data TO jale_cap_retention'], ['REVOKE pg_read_all_data FROM jale_cap_retention'],
      { check: 'owner_memberships', object: 'jale_cap_retention', detail: 'member of pg_read_all_data' }],
    ['a listed right given WITH GRANT OPTION', ['GRANT SELECT ON public.users TO jale_api WITH GRANT OPTION'],
      ['REVOKE GRANT OPTION FOR SELECT ON public.users FROM jale_api'],
      { check: 'grant_option', object: 'public.users', detail: 'jale_api holds SELECT WITH GRANT OPTION' }],
    ['a view in an app schema', ['CREATE VIEW public.lp_posture_view AS SELECT 1 AS one'], ['DROP VIEW public.lp_posture_view'],
      { check: 'unclassified_relation', object: 'public.lp_posture_view', detail: 'view not classified in the manifest' }],
    ['the operator group made a member of a role', ['GRANT pg_read_all_data TO jale_ops_readonly'],
      ['REVOKE pg_read_all_data FROM jale_ops_readonly'],
      { check: 'group_memberships', object: 'jale_ops_readonly', detail: 'member of pg_read_all_data' }],
    ['a table privilege granted to the operator group', ['GRANT SELECT ON public.document_upload_tokens TO jale_ops_readonly'],
      ['REVOKE SELECT ON public.document_upload_tokens FROM jale_ops_readonly'],
      { check: 'group_privileges', object: 'jale_ops_readonly', detail: 'holds 1 table, column or sequence privilege' }],
    ['the operator group given BYPASSRLS', ['ALTER ROLE jale_ops_readonly BYPASSRLS'], ['ALTER ROLE jale_ops_readonly NOBYPASSRLS'],
      { check: 'group_attributes', object: 'jale_ops_readonly', detail: 'carries BYPASSRLS' }],
    ['a large object owned by a runtime login',
      [`DO $$ BEGIN EXECUTE format('ALTER LARGE OBJECT %s OWNER TO jale_api', lo_create(0)); END $$`],
      [`SELECT lo_unlink(m.oid) FROM pg_catalog.pg_largeobject_metadata m WHERE m.lomowner = 'jale_api'::regrole`],
      { check: 'large_object_owner', object: 'jale_api', detail: 'owns 1 large object' }],
  ];

  it.each(FAULTS)('names %s, and is clean again once it is reverted', async (_label, apply, revert, violation) => {
    const faulty = await withFault(apply, revert);
    expect(faulty.complete).toBe(true);
    expect(faulty.violations).toContainEqual(violation);
    const after = await postureAs(manifest);
    expect(after.violations).toEqual([]);
  });

  describe('role-level settings of the runtime logins', () => {
    // A fresh value per run: the reports must never carry it.
    const value = randomUUID();
    const inDatabase = (sql: string) => `DO $$ BEGIN EXECUTE format('${sql}', current_database()); END $$`;
    const SETTING_FAULTS: Array<[string, string[], string[], PostureViolation]> = [
      ['a login without its reviewed timeout', ['ALTER ROLE jale_api RESET idle_in_transaction_session_timeout'],
        [`ALTER ROLE jale_api SET idle_in_transaction_session_timeout = '60s'`],
        { check: 'login_settings', object: 'jale_api', detail: 'setting idle_in_transaction_session_timeout is missing' }],
      ['a different timeout', [`ALTER ROLE jale_job_digest SET idle_in_transaction_session_timeout = '10min'`],
        [`ALTER ROLE jale_job_digest SET idle_in_transaction_session_timeout = '60s'`],
        { check: 'login_settings', object: 'jale_job_digest', detail: 'setting idle_in_transaction_session_timeout differs from the manifest' }],
      ['a setting the manifest does not list', [`ALTER ROLE jale_job_retention SET app.current_internal_user_id = '${value}'`],
        ['ALTER ROLE jale_job_retention RESET app.current_internal_user_id'],
        { check: 'login_settings', object: 'jale_job_retention', detail: 'unexpected setting app.current_internal_user_id' }],
      ['a setting scoped to one database', [inDatabase(`ALTER ROLE jale_api_public IN DATABASE %I SET app.current_user_id = ''${value}''`)],
        [inDatabase('ALTER ROLE jale_api_public IN DATABASE %I RESET app.current_user_id')],
        { check: 'login_settings', object: 'jale_api_public', detail: 'database-scoped setting app.current_user_id' }],
    ];

    it.each(SETTING_FAULTS)('names %s by the setting\'s name only, and is clean again once it is reverted', async (_label, apply, revert, violation) => {
      const faulty = await withFault(apply, revert);
      expect(faulty.complete).toBe(true);
      expect(faulty.violations).toContainEqual(violation);
      expect(JSON.stringify(faulty)).not.toContain(value);
      expect(JSON.stringify(faulty)).not.toContain('10min');
      expect((await postureAs(manifest)).violations).toEqual([]);
    });
  });

  describe('unlisted logins', () => {
    const PERSON = 'jale_person_posture_fixture';
    const STRAY = 'jale_stray_posture_fixture';

    afterEach(async () => {
      await su.query(`DROP ROLE IF EXISTS ${PERSON}`);
      await su.query(`DROP ROLE IF EXISTS ${STRAY}`);
    });

    it('accepts a personal operator login in the one accepted shape, with its own role settings', async () => {
      await withLoginClient(manifest.master, async (admin) => {
        await admin.query(`CREATE ROLE ${PERSON} LOGIN VALID UNTIL '2099-01-01'`);
        await admin.query(`GRANT jale_ops_readonly TO ${PERSON} WITH INHERIT TRUE, SET FALSE`);
        await admin.query(`ALTER ROLE ${PERSON} SET default_transaction_read_only = on`);
        await admin.query(`ALTER ROLE ${PERSON} SET statement_timeout = '30s'`);
      });
      const result = await postureAs(manifest);
      expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
    });

    it('names any other unlisted login', async () => {
      await withLoginClient(manifest.master, (admin) => admin.query(`CREATE ROLE ${STRAY} LOGIN`));
      const result = await postureAs(manifest);
      expect(result.violations).toEqual([
        { check: 'unlisted_login', object: STRAY, detail: 'VALID UNTIL is unset or infinity' },
        { check: 'unlisted_login', object: STRAY, detail: 'not a member of the operator group' },
      ]);
    });
  });

  describe('a manifest.d fragment', () => {
    const TABLE = 'public.posture_fragment_fixture';
    const LOGIN = 'jale_job_posture_fixture';
    let dir: string;

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jale-posture-fragment-'));
      fs.copyFileSync(path.join(shippedAccessDir, 'manifest.json'), path.join(dir, 'manifest.json'));
      fs.mkdirSync(path.join(dir, 'manifest.d'));
      const shippedFragments = path.join(shippedAccessDir, 'manifest.d');
      if (fs.existsSync(shippedFragments)) {
        for (const name of fs.readdirSync(shippedFragments)) {
          fs.copyFileSync(path.join(shippedFragments, name), path.join(dir, 'manifest.d', name));
        }
      }
      fs.writeFileSync(path.join(dir, 'manifest.d', 'zz-posture-fixture.json'), JSON.stringify({
        logins: {
          [LOGIN]: {
            kind: 'job', created_by: 'fixture', connection_limit: 5, prepare_secret: true,
            workloads: 'A fixture job declared only by a fragment.', reason: 'Proves posture reads the merged manifest.',
          },
        },
        tables: {
          [TABLE]: {
            classification: 'excluded', rls: { enabled: true, forced: true }, access: {},
            reason: 'A fixture table declared only by a fragment.',
          },
        },
      }));
      await withLoginClient(manifest.master, async (admin) => {
        await admin.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY)`);
        await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
        await admin.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
        await admin.query(`CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5`);
      });
    });

    afterAll(async () => {
      await su.query(`DROP TABLE IF EXISTS ${TABLE}`);
      await su.query(`DROP ROLE IF EXISTS ${LOGIN}`);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps the run complete and clean when the fragment declares the new objects', async () => {
      const result = await postureAs(loadManifest(dir));
      expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
    });

    it('names the same objects when no fragment declares them', async () => {
      const result = await postureAs(manifest);
      expect(result.complete).toBe(true);
      expect(result.violations).toEqual(expect.arrayContaining([
        { check: 'unclassified_table', object: TABLE, detail: 'not classified in the manifest' },
        { check: 'unlisted_login', object: LOGIN, detail: 'not a member of the operator group' },
      ]));
    });
  });

  describe('extensions', () => {
    it('runs a registered extension\'s catalog reads as the posture login and reports its violations', async () => {
      const ext: PostureExtension<Array<{ who: string }>> = {
        name: 'fixture',
        read: async (client) => (await client.query('SELECT current_user AS who')).rows as Array<{ who: string }>,
        evaluate: (rows) => rows.map((row) => ({ check: 'audit_table_grants', object: row.who, detail: 'fixture' })),
      };
      const result = await postureAs(manifest, [ext]);
      expect(result).toMatchObject({
        complete: true,
        violations: [{ check: 'audit_table_grants', object: 'jale_posture', detail: 'fixture' }],
      });
    });
  });

  describe('session state', () => {
    it('leaves the session search_path as it found it, on a connection that is reused afterwards', async () => {
      await withLoginClient('jale_posture', async (client) => {
        await client.query('SET search_path = pg_catalog, "$user"');
        const before = (await client.query<{ search_path: string }>('SHOW search_path')).rows[0].search_path;
        await readPostureRows(client);
        expect((await client.query<{ search_path: string }>('SHOW search_path')).rows[0].search_path).toBe(before);
      });
    });
  });

  describe('the posture function\'s own identity check, on this bed', () => {
    const savedLogin = process.env.DB_EXPECTED_LOGIN;
    let silenced: jest.SpyInstance[] = [];
    beforeEach(() => {
      process.env.DB_EXPECTED_LOGIN = 'jale_posture';
      silenced = [jest.spyOn(console, 'log').mockImplementation(() => undefined),
        jest.spyOn(console, 'error').mockImplementation(() => undefined)];
    });
    afterEach(() => {
      if (savedLogin === undefined) delete process.env.DB_EXPECTED_LOGIN;
      else process.env.DB_EXPECTED_LOGIN = savedLogin;
      for (const spy of silenced) spy.mockRestore();
    });

    /** The handler with the bed's connection in place of the TLS one; the secret names the posture login. */
    function handlerConnectingWith(open: () => Client) {
      return createPostureCheckHandler({
        readManifest: () => manifest,
        readSecret: async () => ({ host: 'localhost', port: 5432, dbname: 'jale', username: 'jale_posture', password: 'unused' }),
        connect: async (): Promise<PostureConnection> => {
          const client = open();
          await client.connect();
          return client;
        },
        checkPosture,
      });
    }

    it('signed in as the posture login, the run is complete and clean', async () => {
      const report = await handlerConnectingWith(() => loginClient('jale_posture'))({ trigger: 'daily' });
      expect({ complete: report.complete, violations: report.violations }).toEqual({ complete: true, violations: [] });
    });

    it('refuses a connection that signed in as another login and took the posture login as its role', async () => {
      const report = await handlerConnectingWith(() => new Client({ connectionString: databaseUrl, options: '-c role=jale_posture' }))(
        { trigger: 'daily' },
      );
      expect(report).toMatchObject({ complete: false, violations: [] });
    });
  });

  describe('incomplete reads', () => {
    it('an unreachable catalog gives complete = false', async () => {
      const client = loginClient('jale_posture');
      await client.connect();
      await client.end();
      const result = await checkPosture(client, manifest);
      expect(result).toMatchObject({ complete: false, violations: [], serverVersion: null });
    });

    it('a read that comes back without its inventory gives complete = false', async () => {
      const result = await withLoginClient('jale_posture', (client) => {
        const truncated: PostureQueryable = {
          query: (text, values) => (text.includes('FROM pg_catalog.pg_roles r') && text.includes('AS can_login')
            ? Promise.resolve({ rows: [] })
            : client.query(text, values)),
        };
        return checkPosture(truncated, manifest);
      });
      expect(result.complete).toBe(false);
    });
  });
});
