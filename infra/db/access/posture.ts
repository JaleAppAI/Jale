/**
 * posture.ts -- the database posture check: catalog-only reads, and a pure
 * evaluation of them against the access manifest.
 *
 * Callers:
 *   - the scheduled posture check, which connects as `jale_posture` (a login
 *     with no table, function or schema rights) and passes the bundled
 *     manifest: `checkPosture(client, loadManifest())`;
 *   - the posture suites on the local test bed.
 *
 * Every read is a system-catalog query, so it needs no privilege beyond the
 * defaults every login has. A violation names objects (roles, tables,
 * functions), never row data, and a failed read's error text never reaches
 * the result.
 *
 * EXTENSIONS. Another module adds checks by registering a PostureExtension in
 * POSTURE_EXTENSIONS (one line); its reads run after the core reads, and its
 * violations follow the core ones.
 *
 * COMPLETE means every read succeeded and saw the inventory it must: the
 * server version, the master role, at least one table, and every registered
 * extension's rows. The deploy gate treats an incomplete run as not clean.
 */
import { manifestDigest, type AccessManifest } from './access-manifest';
import { coverageViolations } from './coverage';
import { readCatalog, type CatalogSnapshot } from './snapshot';
import { auditPosture } from './posture-audit';

/** The query surface the check needs. A pg `Client` or `PoolClient` fits. */
export interface PostureQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** What a violation is about. */
export type PostureCheck =
  /** A login the manifest does not list, outside the one accepted operator shape. */
  | 'unlisted_login'
  /** A table the manifest does not classify. */
  | 'unclassified_table'
  /** A view, materialized view or foreign table: the manifest classifies tables only. */
  | 'unclassified_relation'
  /** Registered by posture-audit.ts: a guard trigger is missing or not enabled. */
  | 'audit_guard_trigger'
  /** Registered by posture-audit.ts: a change-log trigger is missing or not enabled. */
  | 'audit_change_trigger'
  /** Registered by posture-audit.ts: a role other than the owner holds a privilege on an audit table. */
  | 'audit_table_grants'
  /** Registered by posture-audit.ts: a personal operator login holds a table, column or sequence privilege. */
  | 'person_login_privileges'
  /** A runtime login is a superuser, or carries BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. */
  | 'login_attributes'
  /** A runtime login is a member of a role (including rds_superuser, where it exists). */
  | 'login_memberships'
  /** A runtime login owns an object. */
  | 'login_ownership'
  /** A runtime login's role-level settings differ from the manifest's, or one is scoped to one database. */
  | 'login_settings'
  /** A runtime or personal login may create temporary tables (TEMPORARY on the database). */
  | 'login_temp'
  /** A role other than the master owns large objects. */
  | 'large_object_owner'
  /** A capability owner or helper role can log in, carries an elevated attribute or INHERIT, or is missing. */
  | 'owner_attributes'
  /** A capability owner or helper role is a member of a role. */
  | 'owner_memberships'
  /** An operator group is missing, can log in, or carries an elevated attribute. */
  | 'group_attributes'
  /** An operator group is a member of a role. */
  | 'group_memberships'
  /** An operator group holds a table, column or sequence privilege. */
  | 'group_privileges'
  /** A role other than the master holds CREATE on the database. */
  | 'database_create'
  /** A role other than the master holds CREATE on schema public. */
  | 'public_schema_create'
  /** Default privileges make new functions executable by PUBLIC. */
  | 'default_public_execute'
  /** The catalog's rights, policies, owners or definitions differ from the manifest (the coverage guard's checks). */
  | 'manifest_drift'
  /** A table's ENABLE or FORCE ROW LEVEL SECURITY flag differs from the manifest. */
  | 'table_rls'
  /** A SECURITY DEFINER function is executable by PUBLIC. */
  | 'definer_public_execute'
  /** A SECURITY DEFINER function's search_path is unset, or differs from the manifest. */
  | 'definer_search_path'
  /** A role holds a SET or INHERIT membership in a capability owner. */
  | 'capability_owner_memberships'
  /** A role other than the object's owner or the master holds a privilege on an app object WITH GRANT OPTION. */
  | 'grant_option';

export interface PostureViolation {
  check: PostureCheck;
  /** The object at fault: a role, `schema.table` or `schema.function(argtypes)`. */
  object: string;
  /** What is wrong, naming objects only. */
  detail: string;
}

export interface PostureResult {
  /** True only when every catalog read succeeded and covered the full inventory. */
  complete: boolean;
  violations: PostureViolation[];
  /** `server_version` as the server reports it; null when it was not read. */
  serverVersion: string | null;
  /** manifestDigest() of the manifest the check ran against. */
  manifestDigest: string;
}

export interface PostureRoleRow {
  name: string;
  /** The cluster's bootstrap superuser (OID 10). */
  bootstrap: boolean;
  can_login: boolean;
  superuser: boolean;
  inherit: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
  bypassrls: boolean;
  connection_limit: number;
  /** VALID UNTIL is set, and not infinity. */
  time_limited: boolean;
  /** Objects the role owns, in any database. */
  owned_objects: number;
  /** Table, column and sequence privileges granted to the role in this database. */
  relation_privileges: number;
  /** The role holds TEMPORARY on this database, directly or through PUBLIC. */
  database_temp: boolean;
}

/** A default-privileges entry for functions. */
export interface PostureFunctionDefaultRow {
  /** The role whose new functions it governs. */
  role: string;
  /** The schema it is limited to, or null for every schema. */
  schema: string | null;
  /** Whether new functions are executable by PUBLIC under it. */
  public_execute: boolean;
}

export interface PostureLargeObjectRow {
  /** The owning role. */
  owner: string;
  /** How many large objects it owns. */
  objects: number;
}

export interface PostureMembershipRow {
  granted: string;
  member: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

export interface PostureTableRow {
  name: string;
  enabled: boolean;
  forced: boolean;
}

/**
 * One role-level setting (`ALTER ROLE ... [IN DATABASE ...] SET`). The value
 * is read only to compare it with the manifest; no violation carries it.
 */
export interface PostureRoleSettingRow {
  role: string;
  /** Set for one database only (`IN DATABASE`). */
  scoped: boolean;
  name: string;
  value: string;
}

/** A relation of a kind the manifest does not classify. */
export interface PostureRelationRow {
  /** `schema.relation`. */
  name: string;
  kind: 'view' | 'materialized view' | 'foreign table';
}

/** A privilege held WITH GRANT OPTION on an object in an app schema. */
export interface PostureGrantOptionRow {
  /** `schema.relation`, `schema.relation.column`, `schema.name(argtypes)`, or a schema name. */
  object: string;
  grantee: string;
  privilege: string;
}

export interface PostureDefinerRow {
  /** `schema.name(argtypes)`, as the manifest keys functions. */
  name: string;
  /** The pinned search_path, or null. */
  search_path: string | null;
  public_execute: boolean;
}

/** Everything the core reads return, plus each extension's own rows. */
export interface PostureRows {
  serverVersion: string;
  roles: PostureRoleRow[];
  memberships: PostureMembershipRow[];
  /** Roles that are members of rds_superuser, where that role exists. */
  rdsSuperuserMembers: string[];
  tables: PostureTableRow[];
  /** Views, materialized views and foreign tables in app schemas. */
  nonTableRelations: PostureRelationRow[];
  definers: PostureDefinerRow[];
  /** Large-object owners in this database, with their counts. */
  largeObjects: PostureLargeObjectRow[];
  /** Roles (or PUBLIC) holding CREATE on this database. */
  databaseCreate: string[];
  /** Roles (or PUBLIC) holding CREATE on schema public. */
  publicSchemaCreate: string[];
  /** Default-privileges entries for functions. */
  functionDefaults: PostureFunctionDefaultRow[];
  /**
   * Privileges held WITH GRANT OPTION on the relations, columns, functions and
   * schemas of app schemas, by any role but the object's owner.
   */
  grantOptions: PostureGrantOptionRow[];
  /** Every role-level setting of a role in this cluster. */
  roleSettings: PostureRoleSettingRow[];
  /**
   * The catalog read the coverage guard compares with the manifest. Present
   * on every real run; when absent (a hand-built evaluation) that comparison
   * is skipped.
   */
  catalog?: CatalogSnapshot;
  /** Keyed by extension name. */
  extensions: Record<string, unknown>;
}

/**
 * A check another module adds to every posture run, registered with one line
 * in POSTURE_EXTENSIONS. `read` runs catalog-only queries as the posture
 * login; if it throws, the whole run is incomplete. `evaluate` is pure and
 * names objects only; its violations follow the core ones.
 */
export interface PostureExtension<Rows = unknown> {
  /** Unique among the registered extensions; keys this extension's rows. */
  name: string;
  read(client: PostureQueryable): Promise<Rows>;
  evaluate(rows: Rows, manifest: AccessManifest): PostureViolation[];
}

/** The registered extensions, run in this order after the core checks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POSTURE_EXTENSIONS: ReadonlyArray<PostureExtension<any>> = [auditPosture];

function incomplete(manifest: AccessManifest): PostureResult {
  return { complete: false, violations: [], serverVersion: null, manifestDigest: manifestDigest(manifest) };
}

/** System and extension-owned objects are never classified. */
const APP_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\\_%'`;

const NOT_EXTENSION_MEMBER = (classid: string, objid: string) => `NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend dep
   WHERE dep.classid = '${classid}'::regclass AND dep.objid = ${objid} AND dep.deptype = 'e')`;

/** The core catalog reads. Each is a plain catalog query any login may run. */
const READS = {
  serverVersion: `SELECT pg_catalog.current_setting('server_version') AS server_version`,
  roles: `
    SELECT r.rolname AS name, r.oid = 10 AS bootstrap, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
           r.rolinherit AS inherit, r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
           r.rolreplication AS replication, r.rolbypassrls AS bypassrls, r.rolconnlimit AS connection_limit,
           (r.rolvaliduntil IS NOT NULL AND r.rolvaliduntil <> 'infinity'::timestamptz) AS time_limited,
           (SELECT count(*) FROM pg_catalog.pg_shdepend d
             WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid
               AND d.deptype = 'o')::int AS owned_objects,
           ((SELECT count(*) FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE a.grantee = r.oid AND a.grantee <> c.relowner)
            + (SELECT count(*) FROM pg_catalog.pg_attribute att
                 JOIN pg_catalog.pg_class c ON c.oid = att.attrelid,
                      pg_catalog.aclexplode(att.attacl) a
                WHERE a.grantee = r.oid AND a.grantee <> c.relowner))::int AS relation_privileges,
           pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMPORARY') AS database_temp
      FROM pg_catalog.pg_roles r
     WHERE r.rolname !~ '^pg_'`,
  memberships: `
    SELECT g.rolname AS granted, m.rolname AS member,
           am.admin_option, am.inherit_option, am.set_option
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = am.member`,
  rdsSuperuserMembers: `
    SELECT r.rolname AS name
      FROM pg_catalog.pg_roles r
     WHERE pg_catalog.to_regrole('rds_superuser') IS NOT NULL
       AND r.rolcanlogin
       AND pg_catalog.pg_has_role(r.oid, pg_catalog.to_regrole('rds_superuser'), 'MEMBER')`,
  tables: `
    SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  nonTableRelations: `
    SELECT n.nspname || '.' || c.relname AS name,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'foreign table' END AS kind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('v', 'm', 'f') AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  definers: `
    SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS name,
           (SELECT substr(cfg, length('search_path=') + 1)
              FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\\_path=%' LIMIT 1) AS search_path,
           EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}`,
  largeObjects: `
    SELECT pg_catalog.pg_get_userbyid(m.lomowner) AS owner, count(*)::int AS objects
      FROM pg_catalog.pg_largeobject_metadata m
     GROUP BY m.lomowner`,
  databaseCreate: `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_catalog.pg_database d,
           pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
     WHERE d.datname = pg_catalog.current_database() AND a.privilege_type = 'CREATE'`,
  publicSchemaCreate: `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_catalog.pg_namespace n,
           pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
     WHERE n.nspname = 'public' AND a.privilege_type = 'CREATE'`,
  grantOptions: `
    SELECT n.nspname || '.' || c.relname AS object,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type AS privilege
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
           pg_catalog.aclexplode(c.relacl) a
     WHERE a.is_grantable AND a.grantee <> c.relowner AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}
    UNION ALL
    SELECT n.nspname || '.' || c.relname || '.' || att.attname,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           a.privilege_type
      FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
           pg_catalog.aclexplode(att.attacl) a
     WHERE a.is_grantable AND a.grantee <> c.relowner AND att.attnum > 0 AND NOT att.attisdropped
       AND ${APP_SCHEMA_FILTER} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}
    UNION ALL
    SELECT n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')',
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           a.privilege_type
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
           pg_catalog.aclexplode(p.proacl) a
     WHERE a.is_grantable AND a.grantee <> p.proowner AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}
    UNION ALL
    SELECT n.nspname::text,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           a.privilege_type
      FROM pg_catalog.pg_namespace n,
           pg_catalog.aclexplode(n.nspacl) a
     WHERE a.is_grantable AND a.grantee <> n.nspowner AND ${APP_SCHEMA_FILTER}
       AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_namespace', 'n.oid')}`,
  roleSettings: `
    SELECT r.rolname AS role, s.setdatabase <> 0 AS scoped,
           pg_catalog.split_part(cfg, '=', 1) AS name,
           pg_catalog.substr(cfg, pg_catalog.strpos(cfg, '=') + 1) AS value
      FROM pg_catalog.pg_db_role_setting s
      JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
     CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) cfg
     WHERE r.rolname !~ '^pg_'`,
  functionDefaults: `
    SELECT pg_catalog.pg_get_userbyid(d.defaclrole) AS role,
           CASE WHEN d.defaclnamespace = 0 THEN NULL ELSE d.defaclnamespace::regnamespace::text END AS schema,
           EXISTS (SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_default_acl d
     WHERE d.defaclobjtype = 'f'`,
} as const;

/** Runs every catalog read, then each extension's. Throws when a read fails. */
export async function readPostureRows(
  client: PostureQueryable,
  extensions: ReadonlyArray<PostureExtension<unknown>> = POSTURE_EXTENSIONS,
): Promise<PostureRows> {
  const names = extensions.map((ext) => ext.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`posture: two extensions are named ${duplicate}`);

  const version = (await client.query(READS.serverVersion)).rows as Array<{ server_version: string }>;
  const roles = (await client.query(READS.roles)).rows as PostureRoleRow[];
  const memberships = (await client.query(READS.memberships)).rows as PostureMembershipRow[];
  const rds = (await client.query(READS.rdsSuperuserMembers)).rows as Array<{ name: string }>;
  const tables = (await client.query(READS.tables)).rows as PostureTableRow[];
  const nonTableRelations = (await client.query(READS.nonTableRelations)).rows as PostureRelationRow[];
  const definers = (await client.query(READS.definers)).rows as PostureDefinerRow[];
  const largeObjects = (await client.query(READS.largeObjects)).rows as PostureLargeObjectRow[];
  const databaseCreate = (await client.query(READS.databaseCreate)).rows as Array<{ grantee: string }>;
  const publicSchemaCreate = (await client.query(READS.publicSchemaCreate)).rows as Array<{ grantee: string }>;
  const functionDefaults = (await client.query(READS.functionDefaults)).rows as PostureFunctionDefaultRow[];
  const grantOptions = (await client.query(READS.grantOptions)).rows as PostureGrantOptionRow[];
  const roleSettings = (await client.query(READS.roleSettings)).rows as PostureRoleSettingRow[];
  // Policy expressions deparse relative to the search_path; read them the way
  // the manifest records them (snapshot.ts), then put the session's own path
  // back, so a pooled connection is returned as it was lent.
  const saved = ((await client.query(`SELECT pg_catalog.current_setting('search_path') AS search_path`))
    .rows as Array<{ search_path: string }>)[0]?.search_path;
  // A server always answers; a path it did not report is never changed.
  if (saved !== undefined) await client.query(`SELECT pg_catalog.set_config('search_path', 'public', false)`);
  let catalog: CatalogSnapshot;
  try {
    catalog = await readCatalog(client);
  } finally {
    if (saved !== undefined) await client.query(`SELECT pg_catalog.set_config('search_path', $1, false)`, [saved]);
  }
  const extensionRows: Record<string, unknown> = {};
  for (const ext of extensions) extensionRows[ext.name] = await ext.read(client);
  return {
    serverVersion: String(version[0]?.server_version ?? ''),
    roles,
    memberships,
    rdsSuperuserMembers: rds.map((r) => r.name),
    tables,
    nonTableRelations,
    definers,
    largeObjects,
    databaseCreate: databaseCreate.map((r) => r.grantee),
    publicSchemaCreate: publicSchemaCreate.map((r) => r.grantee),
    functionDefaults,
    grantOptions,
    roleSettings,
    catalog,
    extensions: extensionRows,
  };
}

const ELEVATED: ReadonlyArray<[keyof PostureRoleRow, string]> = [
  ['superuser', 'SUPERUSER'], ['bypassrls', 'BYPASSRLS'], ['createrole', 'CREATEROLE'],
  ['createdb', 'CREATEDB'], ['replication', 'REPLICATION'],
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function compareViolations(a: PostureViolation, b: PostureViolation): number {
  for (const key of ['check', 'object', 'detail'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/**
 * Pure: the core checks.
 *   - every runtime login: present, can log in, no elevated attribute, member
 *     of nothing (rds_superuser included), owns nothing, no TEMPORARY on the
 *     database, and exactly the manifest's role-level settings, none scoped
 *     to one database (named by the setting, never its value); a dedicated
 *     login also NOINHERIT with its reviewed connection limit;
 *   - every other login: the bootstrap superuser, a listed platform role, or
 *     a personal operator login in the one accepted shape, without TEMPORARY;
 *   - large objects: owned by the master only, each other owner named;
 *   - every capability owner and helper role: present, cannot log in, no
 *     elevated attribute, NOINHERIT, member of nothing;
 *   - every operator group: present, cannot log in, no elevated attribute,
 *     member of nothing, no table, column or sequence privilege (its members
 *     are the personal operator logins, held to their own shape above);
 *   - CREATE on the database and on schema public: the master only;
 *   - default privileges: new functions are never PUBLIC-executable, and the
 *     master's own default revoke is in place;
 *   - the coverage guard's catalog-versus-manifest checks (rights of every
 *     login, owner and PUBLIC, policy roles and recorded expressions,
 *     owners and definitions), each named as manifest_drift;
 *   - every table: classified, with the manifest's row-security flags;
 *   - no view, materialized view or foreign table: the manifest classifies
 *     tables only, so any other relation in an app schema is refused;
 *   - every definer: not executable by PUBLIC, search_path pinned, ending in
 *     pg_temp, and as the manifest lists it;
 *   - no SET or INHERIT membership in a capability owner;
 *   - no privilege on an app schema, relation, column or function held WITH
 *     GRANT OPTION by any role but the object's owner or the master.
 */
function coreViolations(rows: PostureRows, manifest: AccessManifest): PostureViolation[] {
  const out: PostureViolation[] = [];
  const add = (check: PostureCheck, object: string, detail: string) => out.push({ check, object, detail });
  const roles = new Map(rows.roles.map((r) => [r.name, r]));
  const outgoing = (member: string) => rows.memberships.filter((m) => m.member === member);

  for (const [login, entry] of Object.entries(manifest.logins)) {
    const r = roles.get(login);
    if (!r) { add('login_attributes', login, 'missing from the catalog'); continue; }
    if (!r.can_login) add('login_attributes', login, 'cannot log in');
    for (const [attr, word] of ELEVATED) if (r[attr]) add('login_attributes', login, `carries ${word}`);
    if (entry.prepare_secret === true) {
      if (r.inherit) add('login_attributes', login, 'carries INHERIT');
      if (r.connection_limit !== entry.connection_limit) {
        add('login_attributes', login, `connection limit ${r.connection_limit}; the manifest says ${entry.connection_limit}`);
      }
    }
    for (const m of outgoing(login)) add('login_memberships', login, `member of ${m.granted}`);
    if (rows.rdsSuperuserMembers.includes(login) && !outgoing(login).some((m) => m.granted === 'rds_superuser')) {
      add('login_memberships', login, 'member of rds_superuser');
    }
    if (r.owned_objects > 0) add('login_ownership', login, `owns ${plural(r.owned_objects, 'object')}`);
    if (r.database_temp) add('login_temp', login, 'holds TEMPORARY on the database');

    // Role-level settings: exactly the manifest's, none scoped to one
    // database. A detail names the setting, never its value.
    const expected = entry.settings ?? {};
    const held = new Map<string, string>();
    for (const setting of rows.roleSettings) {
      if (setting.role !== login) continue;
      if (setting.scoped) add('login_settings', login, `database-scoped setting ${setting.name}`);
      else held.set(setting.name, setting.value);
    }
    for (const [name, value] of Object.entries(expected)) {
      if (!held.has(name)) add('login_settings', login, `setting ${name} is missing`);
      else if (held.get(name) !== value) add('login_settings', login, `setting ${name} differs from the manifest`);
    }
    for (const name of held.keys()) {
      if (!Object.prototype.hasOwnProperty.call(expected, name)) add('login_settings', login, `unexpected setting ${name}`);
    }
  }

  const groups = new Set(Object.keys(manifest.groups));
  for (const r of rows.roles) {
    if (!r.can_login || r.bootstrap || r.name === manifest.master || r.name in manifest.logins
        || r.name in manifest.platform_roles) continue;
    const problems: string[] = [];
    const memberOf = outgoing(r.name);
    const operator = memberOf.filter((m) => groups.has(m.granted));
    if (operator.length === 0) {
      problems.push('not a member of the operator group');
    } else if (operator.some((m) => m.admin_option || !m.inherit_option || m.set_option)) {
      problems.push('operator membership is not exactly INHERIT TRUE, SET FALSE, no ADMIN');
    }
    for (const m of memberOf) if (!groups.has(m.granted)) problems.push(`member of ${m.granted}`);
    if (!r.time_limited) problems.push('VALID UNTIL is unset or infinity');
    for (const [attr, word] of ELEVATED) if (r[attr]) problems.push(`carries ${word}`);
    if (r.owned_objects > 0) problems.push(`owns ${plural(r.owned_objects, 'object')}`);
    if (r.relation_privileges > 0) {
      problems.push(`holds ${plural(r.relation_privileges, 'table, column or sequence privilege')}`);
    }
    for (const detail of problems) add('unlisted_login', r.name, detail);
    if (r.database_temp) add('login_temp', r.name, 'holds TEMPORARY on the database');
  }

  for (const lo of rows.largeObjects) {
    if (lo.owner !== manifest.master) add('large_object_owner', lo.owner, `owns ${plural(lo.objects, 'large object')}`);
  }

  // The identities the definers and policies run as.
  for (const name of [...Object.keys(manifest.capability_owners), ...Object.keys(manifest.helper_roles)]) {
    const r = roles.get(name);
    if (!r) { add('owner_attributes', name, 'missing from the catalog'); continue; }
    if (r.can_login) add('owner_attributes', name, 'carries LOGIN');
    for (const [attr, word] of ELEVATED) if (r[attr]) add('owner_attributes', name, `carries ${word}`);
    if (r.inherit) add('owner_attributes', name, 'carries INHERIT');
    for (const m of outgoing(name)) add('owner_memberships', name, `member of ${m.granted}`);
  }

  // The operator groups. Their members are the personal operator logins
  // (checked above, in the one accepted shape), so a group holds nothing of
  // its own: no membership and no table, column or sequence privilege.
  for (const name of Object.keys(manifest.groups)) {
    const r = roles.get(name);
    if (!r) { add('group_attributes', name, 'missing from the catalog'); continue; }
    if (r.can_login) add('group_attributes', name, 'carries LOGIN');
    for (const [attr, word] of ELEVATED) if (r[attr]) add('group_attributes', name, `carries ${word}`);
    for (const m of outgoing(name)) add('group_memberships', name, `member of ${m.granted}`);
    if (r.relation_privileges > 0) {
      add('group_privileges', name, `holds ${plural(r.relation_privileges, 'table, column or sequence privilege')}`);
    }
  }

  // Who may create objects: the master only. The bootstrap superuser, the
  // service's own platform roles and the database-owner pseudo-role (the
  // master, on schema public) are not runtime principals.
  const bootstrap = rows.roles.filter((r) => r.bootstrap).map((r) => r.name);
  const administrative = new Set([manifest.master, ...bootstrap, ...Object.keys(manifest.platform_roles), 'pg_database_owner']);
  for (const grantee of new Set(rows.databaseCreate)) {
    if (!administrative.has(grantee)) add('database_create', grantee, 'holds CREATE on the database');
  }
  for (const grantee of new Set(rows.publicSchemaCreate)) {
    if (!administrative.has(grantee)) add('public_schema_create', grantee, 'holds CREATE on schema public');
  }

  // A role with no function default entry gets PostgreSQL's default, which
  // makes new functions executable by PUBLIC; 104 revokes that for the master.
  const masterRevoke = rows.functionDefaults.some((d) => d.role === manifest.master && d.schema === null && !d.public_execute);
  if (!masterRevoke) add('default_public_execute', manifest.master, 'functions it creates are executable by PUBLIC');
  for (const d of rows.functionDefaults) {
    if (!d.public_execute || (d.role === manifest.master && d.schema === null)) continue;
    add('default_public_execute', d.role, d.schema === null
      ? 'functions it creates are executable by PUBLIC'
      : `functions it creates in schema ${d.schema} are executable by PUBLIC`);
  }

  if (rows.catalog) {
    for (const v of coverageViolations(rows.catalog, manifest)) add('manifest_drift', v.object, `check ${v.check}: ${v.detail}`);
  }

  const catalogTables = new Map(rows.tables.map((t) => [t.name, t]));
  for (const [name, entry] of Object.entries(manifest.tables)) {
    const t = catalogTables.get(name);
    if (!t) {
      if (entry.runner_managed !== true) add('table_rls', name, 'missing from the catalog');
      continue;
    }
    if (t.enabled !== entry.rls.enabled) {
      add('table_rls', name, `ROW LEVEL SECURITY is ${t.enabled ? 'on' : 'off'}; the manifest says ${entry.rls.enabled ? 'on' : 'off'}`);
    }
    if (t.forced !== entry.rls.forced) {
      add('table_rls', name, `FORCE ROW LEVEL SECURITY is ${t.forced ? 'on' : 'off'}; the manifest says ${entry.rls.forced ? 'on' : 'off'}`);
    }
  }
  for (const t of rows.tables) {
    if (!(t.name in manifest.tables)) add('unclassified_table', t.name, 'not classified in the manifest');
  }
  for (const r of rows.nonTableRelations) add('unclassified_relation', r.name, `${r.kind} not classified in the manifest`);

  for (const d of rows.definers) {
    if (d.public_execute) add('definer_public_execute', d.name, 'executable by PUBLIC');
    if (d.search_path === null) {
      add('definer_search_path', d.name, 'search_path is not pinned');
    } else if (d.search_path.split(',').map((part) => part.trim()).pop() !== 'pg_temp') {
      add('definer_search_path', d.name, 'search_path does not end in pg_temp');
    } else {
      const listed = manifest.functions[d.name];
      if (listed && listed.search_path !== d.search_path) add('definer_search_path', d.name, 'search_path differs from the manifest');
    }
  }

  const owners = new Set(Object.keys(manifest.capability_owners));
  for (const m of rows.memberships) {
    if (!owners.has(m.granted)) continue;
    if (m.set_option) add('capability_owner_memberships', m.granted, `${m.member} holds SET`);
    if (m.inherit_option) add('capability_owner_memberships', m.granted, `${m.member} holds INHERIT`);
  }

  // A grant option lets its holder pass the right on without a migration. An
  // owner's grant options are implicit and never stored; the master may hold
  // them. Two grantors of the same right name it once.
  const grantable = new Set<string>();
  for (const g of rows.grantOptions) {
    const detail = `${g.grantee} holds ${g.privilege} WITH GRANT OPTION`;
    if (g.grantee === manifest.master || grantable.has(`${g.object}\u0000${detail}`)) continue;
    grantable.add(`${g.object}\u0000${detail}`);
    add('grant_option', g.object, detail);
  }

  return out.sort(compareViolations);
}

/** Pure: evaluates catalog rows against the manifest. */
export function evaluatePosture(
  rows: PostureRows,
  manifest: AccessManifest,
  extensions: ReadonlyArray<PostureExtension<unknown>> = POSTURE_EXTENSIONS,
): PostureResult {
  const complete = rows.serverVersion.trim() !== ''
    && rows.roles.some((r) => r.name === manifest.master)
    && rows.tables.length > 0
    && extensions.every((ext) => Object.prototype.hasOwnProperty.call(rows.extensions, ext.name));
  const violations = coreViolations(rows, manifest);
  for (const ext of extensions) {
    if (Object.prototype.hasOwnProperty.call(rows.extensions, ext.name)) {
      violations.push(...ext.evaluate(rows.extensions[ext.name], manifest));
    }
  }
  return {
    complete,
    violations,
    serverVersion: rows.serverVersion.trim() === '' ? null : rows.serverVersion,
    manifestDigest: manifestDigest(manifest),
  };
}

/**
 * Reads the catalog and evaluates it. Never throws: any failure is an
 * incomplete result, so the caller always has a report to publish.
 */
export async function checkPosture(
  client: PostureQueryable,
  manifest: AccessManifest,
  extensions: ReadonlyArray<PostureExtension<unknown>> = POSTURE_EXTENSIONS,
): Promise<PostureResult> {
  try {
    return evaluatePosture(await readPostureRows(client, extensions), manifest, extensions);
  } catch {
    return incomplete(manifest);
  }
}
