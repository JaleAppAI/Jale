/**
 * migration-119-out-of-order.test.ts
 *
 * Proves that migration 119 leaves the same database in either apply order.
 * Production applied 118, then 120 through 126, and applies 119 after 126,
 * then 127 onward (the runner applies a pending file even when higher
 * numbers are already recorded). A fresh database applies the runner's list
 * in order: 118, 119, 120 ... Two builds on one bare cluster:
 *
 *   database B  the runner's list (scripts/run-migrations.sh MIGRATIONS), in order;
 *   database A  the production order: the same list without 119, with 119
 *               put back directly after 126, so 120 through 126 come before
 *               it and 127 onward after it.
 *
 * The list is read from the runner, never written out here. Only 126, the
 * last migration production applied before 119, is named; the files after it
 * are read from the list, so a migration added to its tail joins both orders
 * (after 119 in A) without an edit to this file.
 *
 * Both builds use the database the bed created, by its name (026 grants
 * CONNECT ON DATABASE jale by name). Roles are cluster-wide, and the chain
 * creates each of its roles only where it is absent, so between the builds
 * the database and every role the chain or this suite created are dropped
 * and the owner is prepared again: each build starts from an empty cluster,
 * as a new database does. B is built first and kept as a snapshot; A stays
 * connected for the checks that need a live database.
 *
 * Compared between A and B: everything infra/db/access/snapshot.ts reads
 * (schemas, tables with their row-security flags, sequences, policies with
 * their expressions, functions with their signatures, and the grants on all
 * of them), plus each function's full definition (an md5 of
 * pg_get_functiondef), column types and defaults, constraints, indexes,
 * triggers, views, default privileges, every grant with its grantor and grant
 * option, the database's own grants, and the attributes, memberships and
 * settings of the chain's roles.
 *
 * Also on A:
 *   - the access-manifest posture check, signed in as the posture login, is
 *     complete and clean;
 *   - jale_internal.employer_has_applicant_relationship keeps the signature
 *     125's policy calls: 119 replaces the same function (same OID, same
 *     arguments and result), and the policy still depends on it;
 *   - an employer created after 126 but before 119, with no company, gets
 *     one from 119's catch-up back-fill (inserted at that point in A, where
 *     production's employers exist);
 *   - a self-check: one conflicting statement applied to A alone (a dropped
 *     119 policy and a changed function body, rolled back afterwards) must be
 *     reported by the comparison, so the comparison is shown to see a
 *     difference.
 *
 * Harness: employer-organizations-118-upgrade.test.ts's.
 * JALE_TEST_UPGRADE_DATABASE_URL is a SUPERUSER URL to the EMPTY database
 * `jale` on a bare Postgres 16 cluster (bootstrap-testbed.sh --bare: no
 * roles, no extension). This suite prepares the jale_admin owner as
 * bootstrap-testbed.sh does, keeps the same migration ledger, and applies
 * every migration as jale_admin. Fixtures are inserted through the superuser
 * connection, past row security. Only a loopback bed is accepted.
 *
 * When JALE_TEST_UPGRADE_DATABASE_URL is absent, every test is explicitly
 * skipped and a concern is logged (Rule 11: no silent skips).
 *
 * Run (the database job's standard leg runs it alone, like the 118 upgrade suite):
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none --bare \
 *     --url-var JALE_TEST_UPGRADE_DATABASE_URL -- \
 *     bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/migrations/migration-119-out-of-order.test.ts
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { canonicalJson, loadManifest } from '../../../../db/access/access-manifest';
import { checkPosture } from '../../../../db/access/posture';
import { readCatalog } from '../../../../db/access/snapshot';
import { loginUrl, testPasswordFor } from '../helpers/login-pool';

const infraRoot = path.join(__dirname, '..', '..', '..', '..');
const repoRoot = path.join(infraRoot, '..');
const migrationsDir = path.join(infraRoot, 'db', 'migrations');

const databaseUrl = process.env.JALE_TEST_UPGRADE_DATABASE_URL;

const MIGRATION_119 = '119_employer_org_owner_access.sql';
/** The last migration production applied before 119 (sprint 28 applied 118, then 120 through 126). */
const LAST_BEFORE_119 = '126_job_conversations_whatsapp_update_columns.sql';
const ADMIN_PASSWORD = 'test-upgrade-admin-pw';
/** 026 grants CONNECT ON DATABASE jale by name, so the chain is applied in a database of that name. */
const BED_DATABASE = 'jale';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const APPLICANT_PREDICATE = 'jale_internal.employer_has_applicant_relationship(text, uuid)';
/** 125's policy that calls the applicant predicate. */
const PREDICATE_CALLER = { table: 'public.whatsapp_processed_messages', policy: 'whatsapp_processed_messages_cap_worker_lane_select' };

/** The canonical chain: scripts/run-migrations.sh MIGRATIONS, in order. */
function runnerMigrations(): string[] {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
  const block = /^MIGRATIONS=\(\n([\s\S]*?)^\)$/m.exec(script);
  if (!block) throw new Error('scripts/run-migrations.sh has no MIGRATIONS=( ... ) block');
  return [...block[1].matchAll(/"(\d{3}[a-z]?_[^"]+\.sql)"/g)].map((m) => m[1]);
}

/**
 * The production order: the list without 119, with 119 put back directly
 * after LAST_BEFORE_119. Everything after that file comes from the list.
 */
function productionOrderOf(list: readonly string[]): string[] {
  const at119 = list.indexOf(MIGRATION_119);
  const atLast = list.indexOf(LAST_BEFORE_119);
  if (at119 < 0) throw new Error(`scripts/run-migrations.sh does not list ${MIGRATION_119}`);
  if (atLast < 0) throw new Error(`scripts/run-migrations.sh does not list ${LAST_BEFORE_119}`);
  if (atLast < at119) throw new Error(`scripts/run-migrations.sh must list ${LAST_BEFORE_119} after ${MIGRATION_119}`);
  const without119 = list.filter((file) => file !== MIGRATION_119);
  const after = without119.indexOf(LAST_BEFORE_119) + 1;
  return [...without119.slice(0, after), MIGRATION_119, ...without119.slice(after)];
}

const listOrder = runnerMigrations();
const productionOrder = productionOrderOf(listOrder);

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function maybeDescribe(name: string, fn: () => void): void {
  if (!databaseUrl) {
    // Rule 11: explicit, loud skip — not a silent pass.
    describe.skip(name, fn);
    // eslint-disable-next-line no-console
    console.warn(
      `[migration-119-out-of-order] SKIPPED: "${name}" — set JALE_TEST_UPGRADE_DATABASE_URL to the EMPTY ` +
        'database jale on a bare local Postgres 16 cluster to run the migration-119 apply-order gate. ' +
        'This is a DONE_WITH_CONCERNS gate: Docker/Postgres was unavailable at test time.',
    );
  } else {
    describe(name, fn);
  }
}

// ── Catalog reads ─────────────────────────────────────────────────────────

/** section -> object key -> facts. Two databases match when every section matches. */
type DatabaseState = Record<string, Record<string, unknown>>;

/** Application objects only, as snapshot.ts filters them. */
const APP_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg\\_%'`;
const NOT_EXTENSION_MEMBER = (classid: string, objid: string) => `NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend dep
   WHERE dep.classid = '${classid}'::regclass AND dep.objid = ${objid} AND dep.deptype = 'e')`;
/** Every role except the cluster's bootstrap superuser and the built-in pg_* roles. */
const CHAIN_ROLES = `SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.oid <> 10 AND r.rolname NOT LIKE 'pg\\_%'`;
/** An ACL as a sorted list of grantee, privilege, grantor and grant option. */
const aclDetail = (aclExpr: string) => `COALESCE((
  SELECT json_agg(json_build_object(
           'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           'privilege', a.privilege_type,
           'grantor', pg_catalog.pg_get_userbyid(a.grantor),
           'grantable', a.is_grantable)
         ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
                  a.privilege_type, pg_catalog.pg_get_userbyid(a.grantor))
    FROM pg_catalog.aclexplode(${aclExpr}) a), '[]'::json)`;

/** Reads beyond snapshot.ts. Each returns (key, value) rows; a repeated key keeps every value. */
const EXTRA_READS: Record<string, string> = {
  function_definitions: `
    SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS key,
           md5(pg_catalog.pg_get_functiondef(p.oid)) AS value
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prokind IN ('f', 'p') AND ${APP_SCHEMA} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}`,
  function_grants: `
    SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS key,
           ${aclDetail("COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))")} AS value
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE ${APP_SCHEMA} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}`,
  relation_grants: `
    SELECT n.nspname || '.' || c.relname AS key,
           json_build_object(
             'kind', c.relkind::text,
             'acl', ${aclDetail("COALESCE(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::\"char\", c.relowner))")},
             'columns', COALESCE((
               SELECT json_agg(json_build_object('column', a.attname, 'acl', ${aclDetail('a.attacl')}) ORDER BY a.attname)
                 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL), '[]'::json)) AS value
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${APP_SCHEMA}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  schema_grants: `
    SELECT n.nspname AS key, ${aclDetail("COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))")} AS value
      FROM pg_catalog.pg_namespace n
     WHERE ${APP_SCHEMA} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_namespace', 'n.oid')}`,
  columns: `
    SELECT n.nspname || '.' || c.relname AS key,
           json_agg(json_build_object(
             'name', a.attname,
             'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
             'not_null', a.attnotnull,
             'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
             'identity', a.attidentity::text,
             'generated', a.attgenerated::text) ORDER BY a.attnum) AS value
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${APP_SCHEMA}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}
     GROUP BY n.nspname, c.relname`,
  constraints: `
    SELECT n.nspname || '.' || c.relname || '.' || con.conname AS key,
           json_build_object(
             'type', con.contype::text,
             'definition', pg_catalog.pg_get_constraintdef(con.oid),
             'deferrable', con.condeferrable,
             'deferred', con.condeferred,
             'validated', con.convalidated) AS value
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE ${APP_SCHEMA}`,
  indexes: `
    SELECT n.nspname || '.' || i.relname AS key, pg_catalog.pg_get_indexdef(i.oid) AS value
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
     WHERE ${APP_SCHEMA} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'i.oid')}`,
  triggers: `
    SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS key,
           json_build_object('definition', pg_catalog.pg_get_triggerdef(t.oid), 'enabled', t.tgenabled::text) AS value
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND ${APP_SCHEMA}`,
  views: `
    SELECT n.nspname || '.' || c.relname AS key,
           json_build_object(
             'kind', c.relkind::text,
             'owner', pg_catalog.pg_get_userbyid(c.relowner),
             'definition', md5(pg_catalog.pg_get_viewdef(c.oid)),
             'options', c.reloptions) AS value
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm') AND ${APP_SCHEMA} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  default_privileges: `
    SELECT pg_catalog.pg_get_userbyid(d.defaclrole) || ' in ' || COALESCE(n.nspname, 'every schema')
             || ' for ' || d.defaclobjtype::text AS key,
           ${aclDetail('d.defaclacl')} AS value
      FROM pg_catalog.pg_default_acl d
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace`,
  database: `
    SELECT 'this database' AS key,
           json_build_object(
             'owner', pg_catalog.pg_get_userbyid(d.datdba),
             'acl', ${aclDetail("COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))")}) AS value
      FROM pg_catalog.pg_database d
     WHERE d.datname = pg_catalog.current_database()`,
  roles: `
    SELECT r.rolname AS key,
           json_build_object(
             'login', r.rolcanlogin, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
             'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'replication', r.rolreplication,
             'bypassrls', r.rolbypassrls, 'connection_limit', r.rolconnlimit, 'valid_until', r.rolvaliduntil) AS value
      FROM pg_catalog.pg_roles r
     WHERE r.oid IN (${CHAIN_ROLES})`,
  role_memberships: `
    SELECT pg_catalog.pg_get_userbyid(m.roleid) || ' granted to ' || pg_catalog.pg_get_userbyid(m.member)
             || ' by ' || pg_catalog.pg_get_userbyid(m.grantor) AS key,
           json_build_object('admin', m.admin_option, 'inherit', m.inherit_option, 'set', m.set_option) AS value
      FROM pg_catalog.pg_auth_members m
     WHERE m.roleid IN (${CHAIN_ROLES}) OR m.member IN (${CHAIN_ROLES})`,
  role_settings: `
    SELECT CASE WHEN s.setrole = 0 THEN 'every role' ELSE pg_catalog.pg_get_userbyid(s.setrole) END || ' in '
             || CASE WHEN s.setdatabase = 0 THEN 'every database'
                     WHEN s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
                       THEN 'this database'
                     ELSE 'another database' END AS key,
           (SELECT json_agg(x ORDER BY x) FROM unnest(s.setconfig) x) AS value
      FROM pg_catalog.pg_db_role_setting s`,
};

/** Reads the database the client is connected to: snapshot.ts's catalog plus EXTRA_READS. */
async function readState(client: Client): Promise<DatabaseState> {
  // As snapshot.ts's CLI reads: policy expressions deparse relative to the search_path.
  await client.query('SET search_path = public');
  const catalog = await readCatalog(client);
  const state: DatabaseState = {
    schemas: catalog.schemas,
    tables: catalog.tables,
    sequences: catalog.sequences,
    policies: catalog.policies,
    functions: catalog.functions,
    guc_refs: { all: catalog.guc_refs },
  };
  for (const [section, sql] of Object.entries(EXTRA_READS)) {
    const grouped: Record<string, unknown[]> = {};
    for (const row of (await client.query<{ key: string; value: unknown }>(sql)).rows) {
      (grouped[row.key] ??= []).push(row.value);
    }
    state[section] = Object.fromEntries(Object.entries(grouped).map(([key, values]) => [
      key,
      values.length === 1 ? values[0] : values.map(canonicalJson).sort(),
    ]));
  }
  return state;
}

/** Every object whose facts differ between A and B, as `section key: what`. Empty when they match. */
function differences(a: DatabaseState, b: DatabaseState): string[] {
  const out: string[] = [];
  for (const section of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const left = a[section] ?? {};
    const right = b[section] ?? {};
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in right)) out.push(`${section} ${key}: only in A`);
      else if (!(key in left)) out.push(`${section} ${key}: only in B`);
      else if (canonicalJson(left[key]) !== canonicalJson(right[key])) out.push(`${section} ${key}: differs`);
    }
  }
  return out;
}

/** The facts behind each difference, for the run log. */
function differenceDetail(a: DatabaseState, b: DatabaseState, found: string[]): string {
  return found.map((entry) => {
    const [section, rest] = [entry.slice(0, entry.indexOf(' ')), entry.slice(entry.indexOf(' ') + 1)];
    const key = rest.slice(0, rest.lastIndexOf(': '));
    return `${entry}\n  A: ${canonicalJson(a[section]?.[key] ?? null)}\n  B: ${canonicalJson(b[section]?.[key] ?? null)}`;
  }).join('\n');
}

// ── The bed ───────────────────────────────────────────────────────────────

const LEDGER = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE public.schema_migrations
    ADD COLUMN IF NOT EXISTS checksum   TEXT,
    ADD COLUMN IF NOT EXISTS applied_by TEXT NOT NULL DEFAULT current_user;
  REVOKE ALL ON public.schema_migrations FROM PUBLIC;`;

/** Throws unless the cluster has none of the chain's roles and the database none of its tables. */
async function requireEmptyCluster(su: Client): Promise<void> {
  const { rows } = await su.query<{ roles: string; users: string | null }>(
    `SELECT (SELECT count(*)::text FROM pg_catalog.pg_roles r WHERE r.oid IN (${CHAIN_ROLES})) AS roles,
            to_regclass('public.users')::text AS users`,
  );
  if (rows[0].roles !== '0' || rows[0].users !== null) {
    throw new Error(
      'migration-119-out-of-order needs a bare cluster (bootstrap-testbed.sh --bare): '
        + `found ${rows[0].roles} non-built-in role(s)${rows[0].users ? ' and an applied chain' : ''}`,
    );
  }
}

/**
 * Prepares the jale_admin owner as bootstrap-testbed.sh does, then applies
 * `files` in order as jale_admin, recording each in the migration ledger as
 * the runner does. `before` runs (as the superuser) just before its file.
 */
async function build(
  su: Client,
  adminUrl: string,
  files: readonly string[],
  before?: { file: string; run: () => Promise<void> },
): Promise<void> {
  // pg_trgm first (008 cannot create it as a non-superuser), CREATEROLE for
  // the helper roles, NOBYPASSRLS so FORCE ROW LEVEL SECURITY holds.
  await su.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await su.query(
    `CREATE ROLE jale_admin LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
     PASSWORD '${ADMIN_PASSWORD}'`,
  );
  await su.query(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO jale_admin', current_database()); END $$`);
  await su.query('ALTER SCHEMA public OWNER TO jale_admin');

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(LEDGER);
    for (const file of files) {
      if (before && before.file === file) await before.run();
      const text = readMigration(file);
      try {
        await admin.query(text);
      } catch (err) {
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      await admin.query(
        `INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [file, createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, file))).digest('hex')],
      );
    }
  } finally {
    await admin.end();
  }
}

/**
 * Drops the bed's database and every role the chain or this suite created,
 * and creates the database again, empty: the next build starts from a bare
 * cluster. Runs on the maintenance database, as bootstrap-testbed.sh --force
 * does. The newest roles go first, so jale_admin, which created the rest,
 * goes last.
 */
async function resetCluster(maintenanceUrl: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${BED_DATABASE} WITH (FORCE)`);
    const { rows } = await maintenance.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_catalog.pg_roles r WHERE r.oid IN (${CHAIN_ROLES}) ORDER BY r.oid DESC`,
    );
    for (const { rolname } of rows) {
      await maintenance.query(`DROP ROLE "${rolname.replace(/"/g, '""')}"`);
    }
    await maintenance.query(`CREATE DATABASE ${BED_DATABASE}`);
  } finally {
    await maintenance.end();
  }
}

type PredicateFacts = {
  oid: string;
  arguments: string;
  returns: string;
  owner: string;
  definer: boolean;
  config: string[] | null;
  definition: string;
};

/** Every function named like the applicant predicate (there must be exactly one). */
async function applicantPredicates(su: Client): Promise<PredicateFacts[]> {
  return (await su.query<PredicateFacts>(
    `SELECT p.oid::text AS oid,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_catalog.pg_get_function_result(p.oid) AS returns,
            pg_catalog.pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS definer,
            p.proconfig AS config,
            md5(pg_catalog.pg_get_functiondef(p.oid)) AS definition
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'jale_internal' AND p.proname = 'employer_has_applicant_relationship'`,
  )).rows;
}

// ── The suite ─────────────────────────────────────────────────────────────

maybeDescribe('migration 119 applied after 126, then 127 onward (the production order)', () => {
  let su: Client;
  let stateA: DatabaseState;
  let stateB: DatabaseState;
  let seed: { employer: string; worker: string };
  let before119: { applied: string[]; predicates: PredicateFacts[]; memberships: string };

  beforeAll(async () => {
    if (!databaseUrl) return;
    const url = new URL(databaseUrl);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error('migration-119-out-of-order: refusing a database that is not a local test bed');
    }
    if (decodeURIComponent(url.pathname.slice(1)) !== BED_DATABASE) {
      throw new Error(`migration-119-out-of-order: the bed's database must be named ${BED_DATABASE} (026 grants CONNECT on it by name)`);
    }
    const maintenanceUrl = new URL(databaseUrl);
    maintenanceUrl.pathname = '/postgres';
    const adminUrl = new URL(databaseUrl);
    adminUrl.username = 'jale_admin';
    adminUrl.password = ADMIN_PASSWORD;

    // Database B: the runner's list, in order.
    const suB = new Client({ connectionString: databaseUrl });
    await suB.connect();
    try {
      await requireEmptyCluster(suB);
      await build(suB, adminUrl.toString(), listOrder);
      stateB = await readState(suB);
    } finally {
      await suB.end();
    }

    await resetCluster(maintenanceUrl.toString());

    // Database A: the list without 119 up to and including 126, then 119,
    // then 127 onward. Between 126 and 119, where production's employers
    // exist, an employer with no company and a worker, for the catch-up
    // back-fill; the ledger at that point is kept to show where it ran.
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await requireEmptyCluster(su);
    await build(su, adminUrl.toString(), productionOrder, {
      file: MIGRATION_119,
      run: async () => {
        const insertUser = async (sub: string, type: 'employer' | 'worker', fullName: string): Promise<string> =>
          (await su.query<{ id: string }>(
            `INSERT INTO public.users (cognito_sub, user_type, full_name) VALUES ($1, $2, $3) RETURNING id`,
            [sub, type, fullName],
          )).rows[0].id;
        const employer = await insertUser('order119-employer', 'employer', 'Test Employer');
        await su.query(`INSERT INTO public.employer_profiles (user_id, company_name) VALUES ($1, 'Test Roofing Co')`, [employer]);
        const worker = await insertUser('order119-worker', 'worker', 'Test Worker');
        seed = { employer, worker };
        before119 = {
          applied: (await su.query<{ filename: string }>('SELECT filename FROM public.schema_migrations'))
            .rows.map((row) => row.filename).sort(),
          predicates: await applicantPredicates(su),
          memberships: (await su.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM public.organization_members WHERE user_id = ANY($1::uuid[])`,
            [[employer, worker]],
          )).rows[0].n,
        };
      },
    });
    stateA = await readState(su);
  }, 1_200_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await su?.end();
  });

  it('reads both orders from the runner: A applies 120 through 126, then 119, then 127 onward', () => {
    const at119 = listOrder.indexOf(MIGRATION_119);
    const atLast = listOrder.indexOf(LAST_BEFORE_119);
    expect(at119).toBeGreaterThan(0);
    expect(atLast).toBeGreaterThan(at119);
    // The runner's list is every migration on disk, in codepoint order.
    const onDisk = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(listOrder).toEqual(onDisk);
    // A applies the same files as B, each once.
    expect([...productionOrder].sort()).toEqual([...listOrder].sort());
    expect(new Set(productionOrder).size).toBe(productionOrder.length);
    // In A, 119 comes directly after 126: the list up to 126 without 119
    // before it, the list after 126 behind it.
    const in119 = productionOrder.indexOf(MIGRATION_119);
    expect(productionOrder[in119 - 1]).toBe(LAST_BEFORE_119);
    expect(productionOrder.slice(0, in119)).toEqual(listOrder.slice(0, atLast + 1).filter((file) => file !== MIGRATION_119));
    expect(productionOrder.slice(in119 + 1)).toEqual(listOrder.slice(atLast + 1));
    // Migrations follow 126, so A applies 119 before them, not last.
    expect(productionOrder.length - in119 - 1).toBeGreaterThan(0);
  });

  it('inserts the back-fill fixture in A after 126 and before 119', () => {
    const in119 = productionOrder.indexOf(MIGRATION_119);
    expect(before119.applied).toEqual([...productionOrder.slice(0, in119)].sort());
    expect(before119.applied).toContain(LAST_BEFORE_119);
    expect(before119.applied).not.toContain(MIGRATION_119);
    for (const later of productionOrder.slice(in119 + 1)) expect(before119.applied).not.toContain(later);
  });

  it('reads a full catalog from both databases', () => {
    for (const state of [stateA, stateB]) {
      expect(Object.keys(state.policies).length).toBeGreaterThan(100);
      expect(Object.keys(state.function_definitions).length).toBeGreaterThan(100);
      expect(Object.keys(state.role_memberships).length).toBeGreaterThan(0);
      expect(state.policies['public.jobs.jobs_org_owner_select']).toBeDefined();
      expect(state.function_definitions[APPLICANT_PREDICATE]).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('leaves the same policies, functions, grants, row-security flags and roles in A as in B', () => {
    const found = differences(stateA, stateB);
    if (found.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[migration-119-out-of-order] A and B differ:\n${differenceDetail(stateA, stateB, found)}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[migration-119-out-of-order] A and B match, objects compared per section: ${
        Object.keys(stateA).sort().map((section) => `${section} ${Object.keys(stateA[section]).length}`).join(', ')}`);
    }
    expect(found).toEqual([]);
  });

  it('passes the access-manifest posture check on A, signed in as the posture login: complete and clean', async () => {
    await su.query(`ALTER ROLE jale_posture PASSWORD '${testPasswordFor('jale_posture')}'`);
    const posture = new Client({ connectionString: loginUrl('jale_posture', databaseUrl) });
    await posture.connect();
    try {
      const result = await checkPosture(posture, loadManifest());
      expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
    } finally {
      await posture.end();
    }
  });

  it('keeps the signature 125 calls: 119 replaces the same applicant predicate in place', async () => {
    const after = await applicantPredicates(su);
    expect(before119.predicates).toHaveLength(1);
    expect(after).toHaveLength(1);
    const [old, now] = [before119.predicates[0], after[0]];
    // Same function: same OID, arguments, result, owner, security and search_path.
    const shape = (f: PredicateFacts) => ({
      oid: f.oid, arguments: f.arguments, returns: f.returns, owner: f.owner, definer: f.definer, config: f.config,
    });
    expect(shape(now)).toEqual(shape(old));
    expect(now).toMatchObject({
      arguments: 'p_employer_internal_id text, p_worker_id uuid',
      returns: 'boolean',
      owner: 'jale_rls_relationship_reader',
      definer: true,
    });
    // 119's body replaced the earlier one, and it is the body B carries.
    expect(now.definition).not.toBe(old.definition);
    expect(now.definition).toBe(stateB.function_definitions[APPLICANT_PREDICATE]);

    // 125's policy still calls that function, by its OID.
    const policyKey = `${PREDICATE_CALLER.table}.${PREDICATE_CALLER.policy}`;
    expect((stateA.policies[policyKey] as { functions: string[] }).functions).toContain(APPLICANT_PREDICATE);
    const depends = await su.query<{ oid: string }>(
      `SELECT d.refobjid::text AS oid
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_policy pol ON pol.oid = d.objid
        WHERE d.classid = 'pg_catalog.pg_policy'::regclass AND d.refclassid = 'pg_catalog.pg_proc'::regclass
          AND pol.polrelid = $1::regclass AND pol.polname = $2
          AND d.refobjid = $3::regprocedure`,
      [PREDICATE_CALLER.table, PREDICATE_CALLER.policy, APPLICANT_PREDICATE],
    );
    expect(depends.rows).toEqual([{ oid: now.oid }]);

    // The role 125's policy applies to can call it with that signature.
    await su.query('BEGIN');
    try {
      await su.query('SET LOCAL ROLE jale_cap_worker_lane');
      const call = await su.query<{ related: boolean }>(
        `SELECT jale_internal.employer_has_applicant_relationship($1::text, $2::uuid) AS related`,
        [seed.employer, seed.worker],
      );
      expect(call.rows).toEqual([{ related: false }]);
    } finally {
      await su.query('ROLLBACK');
    }
  });

  it('gives an employer created after 126 but before 119, with no company, a company of its own through the catch-up back-fill', async () => {
    expect(before119.memberships).toBe('0');
    const { rows } = await su.query<{ user_id: string; role: string; status: string; name: string; members: string }>(
      `SELECT m.user_id, m.role, m.status, o.name,
              (SELECT count(*)::text FROM public.organization_members x WHERE x.organization_id = m.organization_id) AS members
         FROM public.organization_members m
         JOIN public.organizations o ON o.id = m.organization_id
        WHERE m.user_id = ANY($1::uuid[])`,
      [[seed.employer, seed.worker]],
    );
    expect(rows).toEqual([{ user_id: seed.employer, role: 'owner', status: 'active', name: 'Test Roofing Co', members: '1' }]);
  });

  // One statement per compared kind, each against an object 119 creates,
  // changes or grants on: a policy, a function body, a grant and a
  // row-security flag. Applied to A alone, in a transaction that is rolled back.
  it('self-check: reports a difference when A alone carries a conflicting statement of each kind', async () => {
    const defined = (await su.query<{ def: string }>(
      `SELECT pg_catalog.pg_get_functiondef($1::regprocedure) AS def`,
      [APPLICANT_PREDICATE],
    )).rows[0].def;
    expect(defined).toContain('AS $function$');
    let changed: DatabaseState | undefined;
    await su.query('BEGIN');
    try {
      await su.query('DROP POLICY jobs_org_owner_select ON public.jobs');
      await su.query(defined.replace('AS $function$', 'AS $function$\n-- self-check'));
      await su.query('REVOKE EXECUTE ON FUNCTION jale_internal.org_owner_scope(text, boolean) FROM jale_cap_worker_lane');
      await su.query('ALTER TABLE public.jobs NO FORCE ROW LEVEL SECURITY');
      changed = await readState(su);
    } finally {
      await su.query('ROLLBACK');
    }
    const found = differences(changed!, stateB);
    // eslint-disable-next-line no-console
    console.log(`[migration-119-out-of-order] self-check, A with the conflicting statements against B:\n${found.join('\n')}`);
    expect(found).toEqual([
      `function_definitions ${APPLICANT_PREDICATE}: differs`,
      'function_grants jale_internal.org_owner_scope(text, boolean): differs',
      'functions jale_internal.org_owner_scope(text, boolean): differs',
      'policies public.jobs.jobs_org_owner_select: only in B',
      'tables public.jobs: differs',
    ]);
    // Rolled back, A matches B again.
    expect(differences(await readState(su), stateB)).toEqual([]);
  });
});
