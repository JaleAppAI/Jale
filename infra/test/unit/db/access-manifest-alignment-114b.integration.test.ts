/**
 * access-manifest-alignment-114b.integration.test.ts -- migration 114b on a real bed.
 *
 * 114b aligns two catalog settings with the reviewed access manifest
 * (infra/db/access/manifest.json and manifest.d): FORCE ROW LEVEL SECURITY is
 * removed from the five tables the manifest lists as not forced, where a table
 * carries it, and schema public is owned by jale_admin. Where the catalog
 * already matches, it changes nothing.
 *
 *   1. The migrated bed: the ledger records 114b with the file's checksum, the
 *      five tables are not forced, jale_admin owns public, and the posture
 *      check is complete and clean.
 *   2. The drift recreated (the five tables forced; public handed to
 *      pg_database_owner, the default owner of that schema since PostgreSQL
 *      15): the posture check names exactly those six differences, and
 *      nothing else in the catalog moved.
 *   3. 114b re-applied as the bed's jale_admin: the catalog is exactly as it
 *      was before the drift (owners, flags and grants of every relation and
 *      schema), and the posture check is clean again.
 *   4. On an aligned catalog, two more runs raise nothing and write no
 *      catalog row.
 *   5. Refusals that change nothing: a session that is not jale_admin, and a
 *      forced table whose owner jale_admin cannot act as.
 *
 * The drift and the fixtures are committed (the posture login and jale_admin
 * read them over their own connections) and always undone in afterEach as the
 * bed's superuser; the DB runner runs suites one at a time, so no other suite
 * sees them.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL); jale_admin and
 * the posture login sign in with the bed's fixed test passwords through
 * helpers/login-pool.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { checkPosture, type PostureResult, type PostureViolation } from '../../../db/access/posture';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: the migration-114b access-manifest alignment PostgreSQL gate was not run', () => {
    console.warn('[access-manifest-alignment-114b] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const MIGRATION = '114b_access_manifest_alignment.sql';
const MIGRATION_PATH = path.join(__dirname, '..', '..', '..', 'db', 'migrations', MIGRATION);

/** The five tables 114b aligns. */
const TABLES = [
  'public.document_upload_tokens',
  'public.whatsapp_conversations',
  'public.whatsapp_outbox',
  'public.whatsapp_processed_messages',
  'public.worker_thread_counters',
] as const;

/** A NOLOGIN role jale_admin is not a member of, for the owner refusal. */
const FIXTURE_OWNER = 'jale_m118_fixture_owner';
/** The table the owner refusal hands to FIXTURE_OWNER. */
const FIXTURE_TABLE = 'public.worker_thread_counters';

const DRIFT = [
  ...TABLES.map((t) => `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`),
  'ALTER SCHEMA public OWNER TO pg_database_owner',
];

/** What the posture check reads while the drift is in place. */
const DRIFT_VIOLATIONS: PostureViolation[] = [
  { check: 'manifest_drift', object: 'public', detail: 'check 1: owner pg_database_owner; the manifest says jale_admin' },
  ...TABLES.map((t): PostureViolation => ({
    check: 'table_rls', object: t, detail: 'FORCE ROW LEVEL SECURITY is on; the manifest says off',
  })),
];

const byText = (a: PostureViolation, b: PostureViolation) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b));

/**
 * One line per relation and per schema outside the system schemas: owner,
 * row-security flags and grants (grantor included, in a fixed order).
 */
const ACL_ENTRY = `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
             || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
             || '/' || pg_catalog.pg_get_userbyid(a.grantor)`;
const CATALOG_STATE_SQL = `
  WITH acl_entries(objid, kind, entry) AS (
    SELECT c.oid, 'r', ${ACL_ENTRY} FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
    UNION ALL
    SELECT n.oid, 'n', ${ACL_ENTRY} FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
  ), acl_text(objid, kind, txt) AS (
    SELECT objid, kind, string_agg(entry, ',' ORDER BY entry) FROM acl_entries GROUP BY objid, kind
  )
  SELECT key, state FROM (
    SELECT 'relation ' || n.nspname || '.' || c.relname AS key,
           'kind=' || c.relkind::TEXT || ' owner=' || pg_catalog.pg_get_userbyid(c.relowner)
           || ' rls=' || c.relrowsecurity::TEXT || ' force=' || c.relforcerowsecurity::TEXT
           || ' acl=' || COALESCE(t.txt, '') AS state
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN acl_text t ON t.objid = c.oid AND t.kind = 'r'
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'schema ' || n.nspname,
           'owner=' || pg_catalog.pg_get_userbyid(n.nspowner) || ' acl=' || COALESCE(t.txt, '')
      FROM pg_catalog.pg_namespace n
      LEFT JOIN acl_text t ON t.objid = n.oid AND t.kind = 'n'
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  ) s
  ORDER BY key`;

/** The catalog rows 114b may write: the five tables and schema public, with their xmin. */
const ALIGNED_ROWS_SQL = `
  SELECT n.nspname || '.' || c.relname AS name, c.relforcerowsecurity::TEXT AS value, c.xmin::TEXT AS xmin
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE (n.nspname || '.' || c.relname) = ANY($1::TEXT[])
  UNION ALL
  SELECT 'schema ' || n.nspname, pg_catalog.pg_get_userbyid(n.nspowner), n.xmin::TEXT
    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'
  ORDER BY 1`;

maybeDescribe('migration 114b: catalog aligned with the access manifest', () => {
  const manifest = loadManifest();
  let su: Client;
  /** The catalog as the migrated bed carries it, before any test changes it. */
  let baseline: Map<string, string>;

  /** The file exactly as the runner applies it: read at use, so a missing file fails the test that needs it. */
  const migrationSql = () => fs.readFileSync(MIGRATION_PATH, 'utf8');

  /** Applies 114b the way run-migrations.sh does: the whole file in one simple
   * query. A failing statement leaves the file's own BEGIN open and aborted,
   * so it is rolled back here (psql would end the session). */
  async function apply118(client: Client): Promise<void> {
    try {
      await client.query(migrationSql());
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  const apply118AsAdmin = () => withLoginClient(manifest.master, apply118);

  const posture = (): Promise<PostureResult> => withLoginClient('jale_posture', (c) => checkPosture(c, manifest));

  async function catalogState(): Promise<Map<string, string>> {
    const { rows } = await su.query<{ key: string; state: string }>(CATALOG_STATE_SQL);
    return new Map(rows.map((r) => [r.key, r.state]));
  }

  /** The keys whose state differs between two catalog reads. */
  function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
    const keys = new Set([...before.keys(), ...after.keys()]);
    return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
  }

  async function alignedRows(): Promise<Array<{ name: string; value: string; xmin: string }>> {
    return (await su.query<{ name: string; value: string; xmin: string }>(ALIGNED_ROWS_SQL, [TABLES])).rows;
  }

  async function forcedTables(): Promise<string[]> {
    return (await alignedRows()).filter((r) => r.value === 'true').map((r) => r.name);
  }

  async function publicOwner(): Promise<string> {
    const { rows } = await su.query<{ owner: string }>(
      `SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname = 'public'`,
    );
    return rows[0].owner;
  }

  async function recreateDrift(): Promise<void> {
    for (const sql of DRIFT) await su.query(sql);
  }

  /** Puts the bed back as the chain left it. Idempotent; runs after every test. */
  async function restore(): Promise<void> {
    await su.query(`ALTER TABLE ${FIXTURE_TABLE} OWNER TO jale_admin`);
    for (const t of TABLES) await su.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await su.query('ALTER SCHEMA public OWNER TO jale_admin');
    await su.query(`DROP ROLE IF EXISTS ${FIXTURE_OWNER}`);
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    baseline = await catalogState();
  });

  afterEach(async () => {
    await restore();
  });

  afterAll(async () => {
    await su?.end();
  });

  it('1. the ledger records 114b, the five tables are not forced, jale_admin owns public, and the posture check is clean', async () => {
    const { rows } = await su.query<{ checksum: string }>(
      'SELECT checksum FROM public.schema_migrations WHERE filename = $1',
      [MIGRATION],
    );
    expect(rows).toEqual([{ checksum: createHash('sha256').update(fs.readFileSync(MIGRATION_PATH)).digest('hex') }]);
    expect(await forcedTables()).toEqual([]);
    expect(await publicOwner()).toBe('jale_admin');
    const result = await posture();
    expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
  }, 60_000);

  it('2-3. names exactly the six differences while the drift is in place, and 114b puts the catalog back as it was', async () => {
    await recreateDrift();

    const drifted = await catalogState();
    expect(changedKeys(baseline, drifted)).toEqual([...TABLES.map((t) => `relation ${t}`), 'schema public'].sort());
    const before = await posture();
    expect(before.complete).toBe(true);
    expect([...before.violations].sort(byText)).toEqual([...DRIFT_VIOLATIONS].sort(byText));

    await apply118AsAdmin();

    expect(await forcedTables()).toEqual([]);
    expect(await publicOwner()).toBe('jale_admin');
    expect(changedKeys(baseline, await catalogState())).toEqual([]);
    const after = await posture();
    expect({ complete: after.complete, violations: after.violations }).toEqual({ complete: true, violations: [] });
  }, 60_000);

  it('2-3b. aligns a partial drift too: one forced table, public already owned by jale_admin', async () => {
    await su.query('ALTER TABLE public.whatsapp_outbox FORCE ROW LEVEL SECURITY');
    expect(await forcedTables()).toEqual(['public.whatsapp_outbox']);

    await apply118AsAdmin();

    expect(await forcedTables()).toEqual([]);
    expect(changedKeys(baseline, await catalogState())).toEqual([]);
  }, 60_000);

  it('4. on an aligned catalog, two more runs raise nothing and write no catalog row', async () => {
    const rowsBefore = await alignedRows();
    expect(rowsBefore).toHaveLength(TABLES.length + 1);

    await apply118AsAdmin();
    await apply118AsAdmin();

    expect(await alignedRows()).toEqual(rowsBefore);
    expect(changedKeys(baseline, await catalogState())).toEqual([]);
    const result = await posture();
    expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
  }, 60_000);

  it('5a. refuses a session that is not jale_admin, and changes nothing', async () => {
    await recreateDrift();
    const drifted = await catalogState();

    await expect(apply118(su)).rejects.toThrow('migration 114b: connect as jale_admin');

    expect(changedKeys(drifted, await catalogState())).toEqual([]);
  }, 60_000);

  it('5b. refuses a forced table whose owner jale_admin cannot act as, and changes nothing', async () => {
    await su.query(`CREATE ROLE ${FIXTURE_OWNER} NOLOGIN`);
    await su.query(`ALTER TABLE ${FIXTURE_TABLE} OWNER TO ${FIXTURE_OWNER}`);
    await recreateDrift();
    const drifted = await catalogState();

    await expect(apply118AsAdmin()).rejects.toThrow(
      `migration 114b: ${FIXTURE_TABLE} is forced, and jale_admin cannot act as its owner ${FIXTURE_OWNER}`,
    );

    expect(changedKeys(drifted, await catalogState())).toEqual([]);
    expect(await forcedTables()).toEqual([...TABLES]);
    expect(await publicOwner()).toBe('pg_database_owner');
  }, 60_000);

  it('the bed is back as the chain left it after every case', async () => {
    expect(changedKeys(baseline, await catalogState())).toEqual([]);
  }, 60_000);
});
