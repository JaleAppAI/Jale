/**
 * least-privilege-coverage.integration.test.ts -- the coverage guard.
 *
 * The access manifest (infra/db/access/manifest.json) is the reviewed list of
 * which login may reach which object. This suite reads the live catalog of a
 * test bed that has EVERY migration on disk applied and fails when the two
 * disagree, so a later migration that adds a table, a grant or a membership
 * without a manifest entry turns this red.
 *
 * The ten checks. 1, 2, 3, 4, 6 and 9 compare the live catalog with the
 * merged manifest (infra/db/access/coverage.ts); 5, 8, 10 and the
 * unlisted-login rule are the posture check's (infra/db/access/posture.ts),
 * run here as well; this suite adds:
 *   1. every app table is classified, and the manifest names no table that
 *      does not exist;
 *   7. no runtime login is a member of any role, owns anything, or carries a
 *      forbidden attribute; the dedicated logins carry exactly their reviewed
 *      attributes; the only membership IN a runtime login is the master's
 *      ADMIN-only creator row (PostgreSQL 16 requires it to set a password);
 *   8. no role holds a SET or INHERIT membership in a capability owner, and
 *      the owners are members of nothing.
 * Operator group rules: every membership in the operator read-only group is
 * exactly `GRANT jale_ops_readonly TO <member> WITH INHERIT TRUE, SET FALSE`
 * (no ADMIN), held by a time-limited login that belongs to nothing else, owns
 * nothing, carries no elevated attribute and holds no write grant; the group
 * holds no write grant either. Each rule has a fixture, created inside a
 * transaction that is rolled back, that proves the guard rejects it.
 *
 * It also proves the bed's migration ledger, which bootstrap-testbed.sh
 * records the way scripts/run-migrations.sh does, and the helper the DB suites
 * read the reviewed policy copies through (helpers/policy-copies.ts).
 *
 * Connection: JALE_TEST_DATABASE_URL, the superuser URL bootstrap-testbed.sh
 * exports. Catalog reads, plus fixtures that are always rolled back, so the
 * suite leaves the bed as it found it.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import {
  dedicatedLogins, loadManifest, runtimeLogins, type AccessManifest, type TableLoginAccess,
} from '../../../db/access/access-manifest';
import { coverageViolations, type CoverageViolation } from '../../../db/access/coverage';
import { baseManifest, MIGRATION_106, policyCopies } from '../../../db/access/generate';
import { checkPosture, type PostureViolation } from '../../../db/access/posture';
import { readCatalog } from '../../../db/access/snapshot';
import { withLoginClient } from './helpers/login-pool';
import { reviewedPolicyCopies } from './helpers/policy-copies';

const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const migrationsDir = path.join(repoRoot, 'infra', 'db', 'migrations');

/**
 * One EXPLAIN per right the manifest lists for `login` on `table`. EXPLAIN
 * plans the statement without running it, but still checks every privilege
 * the statement needs, including the tables, columns and functions the
 * policies that apply to the login read. A right that some policy makes
 * unusable fails here instead of in production.
 */
function rightProbes(table: string, access: TableLoginAccess, firstColumn: string): string[] {
  const quoted = (columns: string[]) => columns.map((c) => `"${c}"`).join(', ');
  const probes: string[] = [];
  if (access.select) probes.push(`EXPLAIN SELECT ${access.select === '*' ? '*' : quoted(access.select)} FROM ${table}`);
  if (access.insert) {
    probes.push(access.insert === '*'
      ? `EXPLAIN INSERT INTO ${table} DEFAULT VALUES`
      : `EXPLAIN INSERT INTO ${table} (${quoted(access.insert)}) VALUES (${access.insert.map(() => 'DEFAULT').join(', ')})`);
  }
  if (access.update) {
    // SET ... = DEFAULT needs no SELECT on the column, so the probe asks for
    // exactly the UPDATE right plus what the policies read.
    probes.push(`EXPLAIN UPDATE ${table} SET "${access.update === '*' ? firstColumn : access.update[0]}" = DEFAULT`);
  }
  if (access.delete) probes.push(`EXPLAIN DELETE FROM ${table}`);
  return probes;
}

/** The chain, in order: scripts/run-migrations.sh's MIGRATIONS array, as the bed reads it. */
function runnerChain(): string[] {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-migrations.sh'), 'utf8');
  const start = script.indexOf('\nMIGRATIONS=(');
  const block = script.slice(start, script.indexOf('\n)', start));
  return [...block.matchAll(/"([0-9]+[a-z]?_[^"]+\.sql)"/g)].map((m) => m[1]);
}

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege coverage guard PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-coverage] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  rolvaliduntil: string | null;
}

interface MembershipRow {
  granted: string;
  member: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

interface OperatorMemberRow {
  member: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
  rolcanlogin: boolean;
  time_limited: boolean;
  other_roles: string[];
  owns_objects: boolean;
  elevated: string[];
}

/**
 * The operator group rules, read live from `client` so a fixture created in
 * an open transaction is seen. Returns one line per problem, naming roles and
 * objects only.
 */
async function operatorGroupViolations(client: Client, manifest: AccessManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const [group, entry] of Object.entries(manifest.groups).sort(([a], [b]) => a.localeCompare(b))) {
    const rules = entry.member_rules;
    const { rows } = await client.query<OperatorMemberRow>(
      `SELECT m.rolname AS member, am.admin_option, am.inherit_option, am.set_option, m.rolcanlogin,
              (m.rolvaliduntil IS NOT NULL AND m.rolvaliduntil <> 'infinity') AS time_limited,
              ARRAY(SELECT o.rolname FROM pg_catalog.pg_auth_members om
                      JOIN pg_catalog.pg_roles o ON o.oid = om.roleid
                     WHERE om.member = m.oid AND o.rolname <> $1
                     ORDER BY 1)::text[] AS other_roles,
              EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                       WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
                         AND d.refobjid = m.oid AND d.deptype = 'o') AS owns_objects,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN m.rolsuper THEN 'rolsuper' END,
                CASE WHEN m.rolcreaterole THEN 'rolcreaterole' END,
                CASE WHEN m.rolcreatedb THEN 'rolcreatedb' END,
                CASE WHEN m.rolreplication THEN 'rolreplication' END,
                CASE WHEN m.rolbypassrls THEN 'rolbypassrls' END
              ], NULL)::text[] AS elevated
         FROM pg_catalog.pg_auth_members am
         JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
         JOIN pg_catalog.pg_roles m ON m.oid = am.member
        WHERE g.rolname = $1
        ORDER BY m.rolname, am.grantor`,
      [group],
    );

    const writeTargets = [group];
    for (const row of rows) {
      if (row.member === manifest.master) {
        // The creator's ADMIN-only row (PostgreSQL 16) is the master's only
        // acceptable membership: no INHERIT, no SET.
        if (!(row.admin_option && !row.inherit_option && !row.set_option)) {
          problems.push(`${row.member}: its only membership in ${group} must be the ADMIN-only creator row`);
        }
        continue;
      }
      writeTargets.push(row.member);
      const grant = rules.grant_options;
      if (row.admin_option !== grant.admin || row.inherit_option !== grant.inherit || row.set_option !== grant.set) {
        problems.push(`${row.member}: membership must be INHERIT TRUE, SET FALSE without ADMIN`);
      }
      if (!row.rolcanlogin) problems.push(`${row.member}: not a login`);
      if (rules.valid_until_required && !row.time_limited) problems.push(`${row.member}: no VALID UNTIL`);
      if (rules.only_this_group) {
        for (const other of row.other_roles) problems.push(`${row.member}: also belongs to ${other}`);
      }
      if (row.owns_objects) problems.push(`${row.member}: owns objects`);
      for (const attr of row.elevated) problems.push(`${row.member}: carries ${attr}`);
    }

    if (!rules.write_grants_allowed) {
      const writes = await client.query<{ role: string; privilege: string; object: string }>(
        `WITH targets AS (
           SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[])
         )
         SELECT t.rolname AS role, a.privilege_type AS privilege, n.nspname || '.' || c.relname AS object
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
           JOIN targets t ON t.oid = a.grantee
          WHERE (c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
             OR (c.relkind = 'S' AND a.privilege_type IN ('USAGE', 'UPDATE'))
         UNION
         SELECT t.rolname, a.privilege_type, n.nspname || '.' || c.relname || '.' || att.attname
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(att.attacl) a
           JOIN targets t ON t.oid = a.grantee
          WHERE a.privilege_type IN ('INSERT', 'UPDATE')
         UNION
         SELECT t.rolname, a.privilege_type, n.nspname
           FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL aclexplode(n.nspacl) a
           JOIN targets t ON t.oid = a.grantee
          WHERE a.privilege_type = 'CREATE'`,
        [writeTargets],
      );
      for (const w of writes.rows.sort((a, b) => `${a.role} ${a.object} ${a.privilege}`.localeCompare(`${b.role} ${b.object} ${b.privilege}`))) {
        problems.push(`${w.role}: holds ${w.privilege} on ${w.object}`);
      }
    }
  }
  return problems;
}

/**
 * Every runtime login's role-level settings (ALTER ROLE ... SET), read live,
 * against the manifest's `settings`: exactly those, none scoped to a single
 * database. One line per problem, naming the login only.
 */
async function loginSettingViolations(client: Client, manifest: AccessManifest): Promise<string[]> {
  const { rows } = await client.query<{ login: string; scoped: boolean; setting: string }>(
    `SELECT r.rolname AS login, s.setdatabase <> 0 AS scoped, cfg AS setting
       FROM pg_catalog.pg_db_role_setting s
       JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
       CROSS JOIN LATERAL unnest(s.setconfig) cfg
      WHERE r.rolname = ANY($1::text[])`,
    [runtimeLogins(manifest)],
  );
  const problems: string[] = [];
  const actual = new Map<string, string[]>();
  for (const row of rows) {
    if (row.scoped) {
      problems.push(`${row.login}: a role setting scoped to one database`);
      continue;
    }
    actual.set(row.login, [...(actual.get(row.login) ?? []), row.setting]);
  }
  for (const login of runtimeLogins(manifest)) {
    const expected = Object.entries(manifest.logins[login].settings ?? {}).map(([name, value]) => `${name}=${value}`).sort();
    const got = [...(actual.get(login) ?? [])].sort();
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(`${login}: role settings ${JSON.stringify(got)}; the manifest lists ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

const SETTING_FIXTURES: Array<[string, string[], string[], PostureViolation]> = [
  ['a login without its timeout', ['ALTER ROLE jale_api RESET idle_in_transaction_session_timeout'],
    ['jale_api: role settings []; the manifest lists ["idle_in_transaction_session_timeout=60s"]'],
    { check: 'login_settings', object: 'jale_api', detail: 'setting idle_in_transaction_session_timeout is missing' }],
  ['a different timeout', ["ALTER ROLE jale_job_digest SET idle_in_transaction_session_timeout = '10min'"],
    ['jale_job_digest: role settings ["idle_in_transaction_session_timeout=10min"]; the manifest lists ["idle_in_transaction_session_timeout=60s"]'],
    { check: 'login_settings', object: 'jale_job_digest', detail: 'setting idle_in_transaction_session_timeout differs from the manifest' }],
  ['a setting the manifest does not list', ["ALTER ROLE jale_posture SET statement_timeout = '1s'"],
    ['jale_posture: role settings ["statement_timeout=1s"]; the manifest lists []'],
    { check: 'login_settings', object: 'jale_posture', detail: 'unexpected setting statement_timeout' }],
  ['a setting scoped to one database',
    ["DO $$ BEGIN EXECUTE format('ALTER ROLE jale_api_public IN DATABASE %I SET work_mem = %L', current_database(), '1MB'); END $$"],
    ['jale_api_public: a role setting scoped to one database'],
    { check: 'login_settings', object: 'jale_api_public', detail: 'database-scoped setting work_mem' }],
];

/**
 * Faults the guard exists to catch, each applied inside a transaction that is
 * rolled back. Each names the violation the catalog checks (coverage.ts) or
 * the posture check must report.
 */
const GUARD_FIXTURES: Array<[string, string[], { coverage?: CoverageViolation; posture?: PostureViolation }]> = [
  ['an unclassified table', ['CREATE TABLE public.lp_guard_fixture (id int)'],
    { coverage: { check: 1, object: 'public.lp_guard_fixture', detail: 'table not classified in the manifest' } }],
  ['an unclassified procedure', ['CREATE PROCEDURE public.lp_guard_proc() LANGUAGE sql AS $$ SELECT 1 $$'],
    { coverage: { check: 1, object: 'public.lp_guard_proc()', detail: 'procedure not classified in the manifest' } }],
  ['a new PUBLIC policy', ['CREATE POLICY lp_guard_public ON public.jobs FOR SELECT USING (false)'],
    { coverage: { check: 1, object: 'public.jobs.lp_guard_public', detail: 'policy not classified in the manifest' } }],
  ['an extra grant', ['GRANT DELETE ON public.users TO jale_api'],
    { coverage: { check: 2, object: 'public.users', detail: 'jale_api holds DELETE; the manifest does not list it' } }],
  ['a missing grant', ['REVOKE SELECT ON public.jobs FROM jale_api'],
    { coverage: { check: 2, object: 'public.jobs', detail: 'jale_api lacks SELECT, which the manifest lists' } }],
  ['an excluded table made reachable', ['GRANT SELECT ON public.organizations TO jale_api'],
    { coverage: { check: 3, object: 'public.organizations', detail: 'excluded, but jale_api holds SELECT' } }],
  ['a missing EXECUTE behind a policy',
    ['REVOKE EXECUTE ON FUNCTION jale_internal.employer_has_applicant_relationship(text, uuid) FROM jale_api'],
    { coverage: {
      check: 4, object: 'public.users.users_employer_applicant_read__api',
      detail: 'applies to jale_api, which cannot execute jale_internal.employer_has_applicant_relationship(text, uuid)',
    } }],
  ['a capability owner with CREATE on public', ['GRANT CREATE ON SCHEMA public TO jale_cap_retention'],
    { coverage: { check: 9, object: 'public', detail: 'capability owner jale_cap_retention holds CREATE on public' } }],
  ['a capability owner\'s policy widened', ['ALTER POLICY users_cap_worker_lane_select ON public.users USING (true)'],
    { coverage: { check: 9, object: 'public.users.users_cap_worker_lane_select', detail: 'USING differs from the manifest' } }],
  ['a job login\'s new policy widened', ['ALTER POLICY email_outbox_digest_select ON public.email_outbox USING (true)'],
    { coverage: { check: 2, object: 'public.email_outbox.email_outbox_digest_select', detail: 'USING differs from the manifest' } }],
  // A copy is compared with its source, so a source widened together with its
  // copies is caught by the source's own recorded expression.
  ['a copy source widened together with its copies',
    ['ALTER POLICY jobs_employer_select ON public.jobs USING (true)',
      'ALTER POLICY jobs_employer_select__api ON public.jobs USING (true)',
      'ALTER POLICY jobs_employer_select__dg ON public.jobs USING (true)'],
    { coverage: { check: 1, object: 'public.jobs.jobs_employer_select', detail: 'USING differs from the manifest' } }],
  ['a report capability owner\'s policy widened',
    ['ALTER POLICY problem_report_contents_cleanup_delete ON public.problem_report_contents USING (true)'],
    { coverage: {
      check: 9, object: 'public.problem_report_contents.problem_report_contents_cleanup_delete', detail: 'USING differs from the manifest',
    } }],
  ['a column-scoped write widened to the whole table', ['GRANT UPDATE ON public.job_applications TO jale_api'],
    { coverage: { check: 2, object: 'public.job_applications', detail: 'jale_api holds UPDATE; the manifest does not list it' } }],
  ['CREATE on the database for a login',
    [`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO jale_api', current_database()); END $$`],
    { posture: { check: 'database_create', object: 'jale_api', detail: 'holds CREATE on the database' } }],
  ['a helper role given BYPASSRLS', ['ALTER ROLE jale_rls_relationship_reader BYPASSRLS'],
    { posture: { check: 'owner_attributes', object: 'jale_rls_relationship_reader', detail: 'carries BYPASSRLS' } }],
  ['new functions reopened to PUBLIC', ['ALTER DEFAULT PRIVILEGES FOR ROLE jale_admin GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
    { posture: { check: 'default_public_execute', object: 'jale_admin', detail: 'functions it creates are executable by PUBLIC' } }],
  ['an unpinned definer', ['ALTER FUNCTION public.employer_display_name(uuid) RESET search_path'],
    { posture: { check: 'definer_search_path', object: 'public.employer_display_name(uuid)', detail: 'search_path is not pinned' } }],
  ['a definer opened to PUBLIC', ['GRANT EXECUTE ON FUNCTION public.employer_display_name(uuid) TO PUBLIC'],
    { posture: { check: 'definer_public_execute', object: 'public.employer_display_name(uuid)', detail: 'executable by PUBLIC' } }],
  ['a membership', ['GRANT jale_rls_relationship_reader TO jale_job_digest'],
    { posture: { check: 'login_memberships', object: 'jale_job_digest', detail: 'member of jale_rls_relationship_reader' } }],
  ['an RLS flag drift', ['ALTER TABLE public.jobs NO FORCE ROW LEVEL SECURITY'],
    { posture: { check: 'table_rls', object: 'public.jobs', detail: 'FORCE ROW LEVEL SECURITY is off; the manifest says on' } }],
  ['a SET membership in a capability owner', ['GRANT jale_cap_retention TO jale_ops_readonly WITH INHERIT FALSE, SET TRUE'],
    { posture: { check: 'capability_owner_memberships', object: 'jale_cap_retention', detail: 'jale_ops_readonly holds SET' } }],
  // Each grantee already holds the right, so only the grant option changes.
  ['a listed right given WITH GRANT OPTION', ['GRANT SELECT ON public.users TO jale_api WITH GRANT OPTION'],
    { posture: { check: 'grant_option', object: 'public.users', detail: 'jale_api holds SELECT WITH GRANT OPTION' } }],
  ['a listed column right given WITH GRANT OPTION',
    ['GRANT SELECT (score) ON public.employer_candidate_rankings TO jale_job_digest WITH GRANT OPTION'],
    { posture: { check: 'grant_option', object: 'public.employer_candidate_rankings.score', detail: 'jale_job_digest holds SELECT WITH GRANT OPTION' } }],
  ['a listed EXECUTE given WITH GRANT OPTION', ['GRANT EXECUTE ON FUNCTION public.employer_display_name(uuid) TO jale_api WITH GRANT OPTION'],
    { posture: { check: 'grant_option', object: 'public.employer_display_name(uuid)', detail: 'jale_api holds EXECUTE WITH GRANT OPTION' } }],
  ['a listed schema USAGE given WITH GRANT OPTION', ['GRANT USAGE ON SCHEMA jale_internal TO jale_api WITH GRANT OPTION'],
    { posture: { check: 'grant_option', object: 'jale_internal', detail: 'jale_api holds USAGE WITH GRANT OPTION' } }],
  ['a view granted to a login',
    ['CREATE VIEW public.lp_guard_view AS SELECT token_hash FROM public.document_upload_tokens',
      'GRANT SELECT ON public.lp_guard_view TO jale_api'],
    { posture: { check: 'unclassified_relation', object: 'public.lp_guard_view', detail: 'view not classified in the manifest' } }],
  ['a materialized view', ['CREATE MATERIALIZED VIEW public.lp_guard_matview AS SELECT 1 AS one'],
    { posture: { check: 'unclassified_relation', object: 'public.lp_guard_matview', detail: 'materialized view not classified in the manifest' } }],
  ['the operator group made a member of a role', ['GRANT pg_read_all_data TO jale_ops_readonly'],
    { posture: { check: 'group_memberships', object: 'jale_ops_readonly', detail: 'member of pg_read_all_data' } }],
  ['a table privilege granted to the operator group', ['GRANT SELECT ON public.document_upload_tokens TO jale_ops_readonly'],
    { posture: { check: 'group_privileges', object: 'jale_ops_readonly', detail: 'holds 1 table, column or sequence privilege' } }],
];

const FIXTURE = 'ops_fixture_member';
const FIXTURE_OTHER = 'ops_fixture_other';
const ACCEPTED_GRANT = `GRANT jale_ops_readonly TO ${FIXTURE} WITH INHERIT TRUE, SET FALSE`;
const LIMITED_LOGIN = `CREATE ROLE ${FIXTURE} LOGIN VALID UNTIL '2099-01-01'`;

/** [label, fixture statements, the problems the guard must report]. */
const OPERATOR_FIXTURES: Array<[string, string[], string[]]> = [
  ['the accepted shape: a time-limited login granted INHERIT TRUE, SET FALSE',
    [LIMITED_LOGIN, ACCEPTED_GRANT], []],
  ['a membership WITH SET TRUE',
    [LIMITED_LOGIN, `GRANT jale_ops_readonly TO ${FIXTURE} WITH INHERIT TRUE, SET TRUE`],
    [`${FIXTURE}: membership must be INHERIT TRUE, SET FALSE without ADMIN`]],
  ['a membership WITH INHERIT FALSE',
    [LIMITED_LOGIN, `GRANT jale_ops_readonly TO ${FIXTURE} WITH INHERIT FALSE, SET FALSE`],
    [`${FIXTURE}: membership must be INHERIT TRUE, SET FALSE without ADMIN`]],
  ['a membership WITH ADMIN TRUE',
    [LIMITED_LOGIN, `GRANT jale_ops_readonly TO ${FIXTURE} WITH ADMIN TRUE, INHERIT TRUE, SET FALSE`],
    [`${FIXTURE}: membership must be INHERIT TRUE, SET FALSE without ADMIN`]],
  ['a member without VALID UNTIL',
    [`CREATE ROLE ${FIXTURE} LOGIN`, ACCEPTED_GRANT], [`${FIXTURE}: no VALID UNTIL`]],
  ["a member VALID UNTIL 'infinity'",
    [`CREATE ROLE ${FIXTURE} LOGIN VALID UNTIL 'infinity'`, ACCEPTED_GRANT], [`${FIXTURE}: no VALID UNTIL`]],
  ['a member that cannot log in',
    [`CREATE ROLE ${FIXTURE} NOLOGIN VALID UNTIL '2099-01-01'`, ACCEPTED_GRANT], [`${FIXTURE}: not a login`]],
  ['a member that also belongs to another role',
    [LIMITED_LOGIN, ACCEPTED_GRANT, `CREATE ROLE ${FIXTURE_OTHER} NOLOGIN`, `GRANT ${FIXTURE_OTHER} TO ${FIXTURE}`],
    [`${FIXTURE}: also belongs to ${FIXTURE_OTHER}`]],
  ['a member with a table write grant',
    [LIMITED_LOGIN, ACCEPTED_GRANT, `GRANT INSERT ON public.jobs TO ${FIXTURE}`],
    [`${FIXTURE}: holds INSERT on public.jobs`]],
  ['a member with a column write grant',
    [LIMITED_LOGIN, ACCEPTED_GRANT, `GRANT UPDATE (title) ON public.jobs TO ${FIXTURE}`],
    [`${FIXTURE}: holds UPDATE on public.jobs.title`]],
  ['a member with CREATE on a schema',
    [LIMITED_LOGIN, ACCEPTED_GRANT, `GRANT CREATE ON SCHEMA public TO ${FIXTURE}`],
    [`${FIXTURE}: holds CREATE on public`]],
  ['a member that owns an object',
    [LIMITED_LOGIN, ACCEPTED_GRANT, 'CREATE TABLE public.ops_fixture_table (id int)',
      `ALTER TABLE public.ops_fixture_table OWNER TO ${FIXTURE}`],
    [`${FIXTURE}: owns objects`]],
  ['a member carrying BYPASSRLS',
    [`CREATE ROLE ${FIXTURE} LOGIN BYPASSRLS VALID UNTIL '2099-01-01'`, ACCEPTED_GRANT],
    [`${FIXTURE}: carries rolbypassrls`]],
  ['the group itself holding a write grant',
    ['GRANT DELETE ON public.jobs TO jale_ops_readonly'],
    ['jale_ops_readonly: holds DELETE on public.jobs']],
  ["the master holding more than its ADMIN-only creator row",
    ['GRANT jale_ops_readonly TO jale_admin WITH INHERIT TRUE'],
    ['jale_admin: its only membership in jale_ops_readonly must be the ADMIN-only creator row']],
];

maybeDescribe('least-privilege coverage guard', () => {
  const manifest = loadManifest();
  let su: Client;
  let roles: Map<string, RoleRow>;
  let memberships: MembershipRow[];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    roles = new Map(
      (await su.query<RoleRow>(
        `SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil::text AS rolvaliduntil
           FROM pg_catalog.pg_roles`,
      )).rows.map((r) => [r.rolname, r]),
    );
    memberships = (await su.query<MembershipRow>(
      `SELECT g.rolname AS granted, m.rolname AS member,
              am.admin_option, am.inherit_option, am.set_option
         FROM pg_catalog.pg_auth_members am
         JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
         JOIN pg_catalog.pg_roles m ON m.oid = am.member`,
    )).rows;
  });

  afterAll(async () => {
    await su?.end();
  });

  describe('check 1: classification', () => {
    it('classifies every table in public, and names no table that does not exist', async () => {
      const { rows } = await su.query<{ name: string }>(
        `SELECT n.nspname || '.' || c.relname AS name
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg\\_%'
          ORDER BY 1`,
      );
      const catalog = rows.map((r) => r.name);
      const classified = Object.keys(manifest.tables).sort();
      expect({ unclassified: catalog.filter((t) => !classified.includes(t)) }).toEqual({ unclassified: [] });
      // A runner-managed table (the migration ledger) may be absent from a
      // database the chain was applied to by hand.
      const missing = classified.filter((t) => !catalog.includes(t) && manifest.tables[t].runner_managed !== true);
      expect({ missing }).toEqual({ missing: [] });
    });
  });

  describe('the migration ledger, and the reviewed policy copies the DB suites read', () => {
    it('records every migration of the chain, in order, with its SHA-256, owned by the master and closed to PUBLIC', async () => {
      const chain = runnerChain();
      expect(chain.length).toBeGreaterThan(100);
      const ledger = await su.query<{ filename: string; checksum: string; applied_by: string }>(
        'SELECT filename, checksum, applied_by FROM public.schema_migrations ORDER BY applied_at, filename',
      );
      expect(ledger.rows.map((r) => r.filename)).toEqual(chain);
      const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(migrationsDir, file))).digest('hex');
      expect(ledger.rows.filter((r) => r.checksum !== sha256(r.filename)).map((r) => r.filename)).toEqual([]);
      expect([...new Set(ledger.rows.map((r) => r.applied_by))]).toEqual([manifest.master]);
      const table = await su.query<{ owner: string; acl: string[] | null }>(
        `SELECT pg_catalog.pg_get_userbyid(relowner) AS owner, relacl::text[] AS acl
           FROM pg_catalog.pg_class WHERE oid = 'public.schema_migrations'::regclass`,
      );
      expect(table.rows[0].owner).toBe(manifest.master);
      expect((table.rows[0].acl ?? []).filter((item) => item.startsWith('='))).toEqual([]);
    });

    it('reads the copies from the generator list while the ledger records 106, and none once it does not', async () => {
      const table = 'public.worker_referred_jobs';
      const expected = policyCopies(baseManifest()).filter((copy) => copy.table === table);
      expect(expected.length).toBeGreaterThan(0);
      expect(await reviewedPolicyCopies(su, table)).toEqual(
        expected.map((copy) => ({ policyname: copy.name, cmd: copy.command, roles: copy.to, copyOf: copy.copyOf })),
      );
      await su.query('BEGIN');
      try {
        await su.query('DELETE FROM public.schema_migrations WHERE filename = $1', [MIGRATION_106.file]);
        expect(await reviewedPolicyCopies(su, table)).toEqual([]);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('refuses a bed with no ledger: it predates the ledger and must be recreated', async () => {
      await su.query('BEGIN');
      try {
        await su.query('ALTER TABLE public.schema_migrations RENAME TO schema_migrations_hidden');
        await expect(reviewedPolicyCopies(su, 'public.worker_referred_jobs')).rejects.toThrow(/no migration ledger/);
      } finally {
        await su.query('ROLLBACK');
      }
    });
  });

  describe('checks 1, 2, 3, 4, 6 and 9: the live catalog against the merged manifest', () => {
    it('every object is classified as the manifest records it, and every right is listed', async () => {
      expect(coverageViolations(await readCatalog(su), manifest)).toEqual([]);
    });
  });

  describe('check 2: the write grants list only the columns their paths write', () => {
    // Each login writes these tables through column grants only; the listed
    // columns are ones no path of that login writes. Evidence for each list
    // is in the table's reason in infra/db/access/manifest.json.
    const FORBIDDEN: Array<[string, string, string[]]> = [
      ['jale_api', 'public.job_applications', ['worker_id', 'job_id', 'applied_at', 'hired_seen_at', 'hired_ack_at']],
      ['jale_api', 'public.users', ['trade_competency_score', 'user_type', 'cognito_sub', 'email', 'whatsapp_number', 'tenant_id']],
      ['jale_api', 'public.job_message_outbox', ['whatsapp_number', 'conversation_id', 'message_id', 'body', 'content_template', 'content_variables']],
      ['jale_api', 'public.job_conversations', ['job_id', 'employer_id', 'worker_id', 'application_id']],
      ['jale_job_email_sender', 'public.email_outbox', ['recipient_email', 'subject', 'body_text', 'body_html', 'headers', 'source_type', 'source_id']],
      ['jale_job_visibility_drain', 'public.job_visibility_events', ['job_id', 'public_code', 'event_kind']],
    ];
    it.each(FORBIDDEN)('%s updates %s by column only, and none of the columns no path writes', async (login, table, columns) => {
      const { rows } = await su.query<{ table_update: boolean; col_name: string; column_update: boolean }>(
        `SELECT pg_catalog.has_table_privilege($1, $2, 'UPDATE') AS table_update, c.col_name,
                pg_catalog.has_column_privilege($1, $2, c.col_name, 'UPDATE') AS column_update
           FROM unnest($3::text[]) AS c(col_name)`,
        [login, table, columns],
      );
      expect(rows.map((r) => [r.col_name, r.table_update, r.column_update])).toEqual(columns.map((c) => [c, false, false]));
    });
  });

  describe('checks 5, 7, 8 and 10: the posture check, run here as the superuser', () => {
    it('is complete and clean: definers, logins, memberships, owners, unlisted logins and row-security flags', async () => {
      const result = await checkPosture(su, manifest);
      expect({ complete: result.complete, violations: result.violations }).toEqual({ complete: true, violations: [] });
    });
  });

  describe('every check can fail (each fixture is rolled back)', () => {
    it.each(GUARD_FIXTURES)('names %s', async (_label, statements, expected) => {
      await su.query('BEGIN');
      try {
        for (const sql of statements) await su.query(sql);
        if (expected.coverage) expect(coverageViolations(await readCatalog(su), manifest)).toContainEqual(expected.coverage);
        if (expected.posture) expect((await checkPosture(su, manifest)).violations).toContainEqual(expected.posture);
      } finally {
        await su.query('ROLLBACK');
      }
    });
  });

  describe('check 4: every right the manifest lists is usable through the policies that apply to it', () => {
    const firstColumn = new Map<string, string>();
    beforeAll(async () => {
      const { rows } = await su.query<{ table_name: string; column_name: string }>(
        `SELECT DISTINCT ON (c.oid) n.nspname || '.' || c.relname AS table_name, a.attname AS column_name
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE c.relkind IN ('r', 'p')
          ORDER BY c.oid, a.attnum`,
      );
      for (const r of rows) firstColumn.set(r.table_name, r.column_name);
    });

    it('as each runtime login, EXPLAIN of every listed command raises no permission error', async () => {
      const refused: string[] = [];
      for (const login of runtimeLogins(manifest)) {
        const tables = Object.entries(manifest.tables)
          .filter(([, entry]) => entry.access[login])
          .sort(([a], [b]) => a.localeCompare(b));
        if (tables.length === 0) continue;
        await withLoginClient(login, async (client) => {
          for (const [table, entry] of tables) {
            for (const probe of rightProbes(table, entry.access[login], firstColumn.get(table) ?? 'id')) {
              try {
                await client.query(probe);
              } catch (err) {
                const { code, message } = err as { code?: string; message: string };
                refused.push(`${login}: ${probe.replace(/^EXPLAIN /, '')}: ${code} ${message}`);
              }
            }
          }
        });
      }
      expect(refused).toEqual([]);
    });

    // A capability owner cannot sign in, so its rights are probed as the role
    // itself inside a rolled-back transaction of the fixture connection. The
    // policies that apply to it include every PUBLIC policy on its tables, and
    // those read other tables too: an owner the manifest lists for a command
    // must be able to evaluate all of them.
    it('as each capability owner, EXPLAIN of every listed command raises no permission error', async () => {
      const refused: string[] = [];
      for (const owner of Object.keys(manifest.capability_owners).sort()) {
        const tables = Object.entries(manifest.tables)
          .filter(([, entry]) => entry.access[owner])
          .sort(([a], [b]) => a.localeCompare(b));
        if (tables.length === 0) continue;
        await su.query('BEGIN');
        try {
          await su.query(`SET LOCAL ROLE ${owner}`);
          for (const [table, entry] of tables) {
            for (const probe of rightProbes(table, entry.access[owner], firstColumn.get(table) ?? 'id')) {
              await su.query('SAVEPOINT probe');
              try {
                await su.query(probe);
                await su.query('RELEASE SAVEPOINT probe');
              } catch (err) {
                await su.query('ROLLBACK TO SAVEPOINT probe');
                const { code, message } = err as { code?: string; message: string };
                refused.push(`${owner}: ${probe.replace(/^EXPLAIN /, '')}: ${code} ${message}`);
              }
            }
          }
        } finally {
          await su.query('ROLLBACK');
        }
      }
      expect(refused).toEqual([]);
    });
  });

  describe('check 7: runtime logins', () => {
    it('every runtime login exists, can log in, and carries no forbidden attribute', () => {
      const problems: string[] = [];
      for (const login of runtimeLogins(manifest)) {
        const role = roles.get(login);
        if (!role) { problems.push(`${login}: missing`); continue; }
        if (!role.rolcanlogin) problems.push(`${login}: cannot log in`);
        for (const attr of ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const) {
          if (role[attr]) problems.push(`${login}: ${attr}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('the dedicated logins carry exactly NOINHERIT and their reviewed connection limit', () => {
      const actual = dedicatedLogins(manifest).map((login) => {
        const role = roles.get(login);
        return [login, role?.rolinherit, role?.rolconnlimit];
      });
      const expected = dedicatedLogins(manifest).map((login) => [login, false, manifest.logins[login].connection_limit]);
      expect(actual).toEqual(expected);
    });

    it('no runtime login is a member of any role', () => {
      const logins = new Set(runtimeLogins(manifest));
      expect(memberships.filter((m) => logins.has(m.member))).toEqual([]);
    });

    it('the only membership in a runtime login is the master\'s ADMIN-only creator row', () => {
      const logins = new Set(runtimeLogins(manifest));
      const unexpected = memberships.filter((m) => logins.has(m.granted) && !(
        m.member === manifest.master && m.admin_option && !m.inherit_option && !m.set_option
      ));
      expect(unexpected).toEqual([]);
    });

    it('no runtime login owns any object', async () => {
      const { rows } = await su.query<{ rolname: string; owned: number }>(
        `SELECT r.rolname, count(d.*)::int AS owned
           FROM pg_catalog.pg_roles r
           LEFT JOIN pg_catalog.pg_shdepend d
             ON d.refclassid = 'pg_catalog.pg_authid'::regclass
            AND d.refobjid = r.oid
            AND d.deptype = 'o'
          WHERE r.rolname = ANY($1::text[])
          GROUP BY r.rolname
         HAVING count(d.*) > 0`,
        [runtimeLogins(manifest)],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('login settings', () => {
    it('every runtime login carries exactly the role settings the manifest lists', async () => {
      expect(await loginSettingViolations(su, manifest)).toEqual([]);
    });

    describe('rejects any other setting (each fixture is rolled back)', () => {
      it.each(SETTING_FIXTURES)('%s', async (_label, statements, expected, posture) => {
        await su.query('BEGIN');
        try {
          for (const sql of statements) await su.query(sql);
          expect(await loginSettingViolations(su, manifest)).toEqual(expected);
          // The posture check names the same fault, by the setting's name only.
          expect((await checkPosture(su, manifest)).violations).toContainEqual(posture);
        } finally {
          await su.query('ROLLBACK');
        }
      });
    });
  });

  describe('check 8: capability owners', () => {
    it('every capability owner is a NOLOGIN, NOINHERIT role with no other attribute', () => {
      const problems: string[] = [];
      for (const owner of Object.keys(manifest.capability_owners)) {
        const role = roles.get(owner);
        if (!role) { problems.push(`${owner}: missing`); continue; }
        for (const attr of ['rolcanlogin', 'rolsuper', 'rolinherit', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const) {
          if (role[attr]) problems.push(`${owner}: ${attr}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('no role holds a SET or INHERIT membership in a capability owner, and owners belong to nothing', () => {
      const owners = new Set(Object.keys(manifest.capability_owners));
      expect(memberships.filter((m) => owners.has(m.granted) && (m.set_option || m.inherit_option))).toEqual([]);
      expect(memberships.filter((m) => owners.has(m.member))).toEqual([]);
    });
  });

  describe('operator group', () => {
    it('the operator read-only group is a NOLOGIN role that belongs to nothing', () => {
      for (const group of Object.keys(manifest.groups)) {
        const role = roles.get(group);
        expect(role && {
          rolcanlogin: role.rolcanlogin, rolsuper: role.rolsuper, rolbypassrls: role.rolbypassrls,
          rolcreaterole: role.rolcreaterole, rolcreatedb: role.rolcreatedb, rolreplication: role.rolreplication,
        }).toEqual({
          rolcanlogin: false, rolsuper: false, rolbypassrls: false,
          rolcreaterole: false, rolcreatedb: false, rolreplication: false,
        });
        expect(memberships.filter((m) => m.member === group)).toEqual([]);
      }
    });

    it('every membership in the operator group has the one accepted shape', async () => {
      expect(await operatorGroupViolations(su, manifest)).toEqual([]);
    });

    describe('rejects every other shape (each fixture is rolled back)', () => {
      it.each(OPERATOR_FIXTURES)('%s', async (_label, statements, expected) => {
        await su.query('BEGIN');
        try {
          for (const sql of statements) await su.query(sql);
          expect(await operatorGroupViolations(su, manifest)).toEqual(expected);
        } finally {
          await su.query('ROLLBACK');
        }
      });
    });
  });
});
