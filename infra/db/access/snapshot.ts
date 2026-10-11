/**
 * snapshot.ts -- a deterministic, catalog-only read of a database: every
 * object the access manifest classifies, with its owner, row-security flags,
 * privileges and policy definitions.
 *
 * Three consumers:
 *   - generate.ts copies policy definitions from a committed snapshot of a
 *     test bed taken before the access-rights migration
 *     (catalog-snapshot.json), so 106 can be regenerated without a database;
 *   - the coverage guard reads the live catalog of a test bed with every
 *     migration applied and compares it with the manifest;
 *   - the posture check reads the same facts as a catalog-only login.
 *
 * Every query reads the system catalog only. No row data is read.
 *
 * Policy expressions come from pg_get_expr(), which qualifies a name only when
 * the session's search_path does not find it. The CLI therefore reads with
 * `search_path = public`, the same path migration 106 sets before it creates
 * the copies, so a copied expression parses back to the same objects.
 *
 * Usage (dev time, against a local test bed only):
 *   npx tsx infra/db/access/snapshot.ts --out infra/db/access/catalog-snapshot.json
 * with JALE_TEST_DATABASE_URL set to the bed's superuser URL.
 */

import * as fs from 'fs';

/** The query surface the reader needs. A pg `Client` or `PoolClient` fits. */
export interface CatalogQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Grantee -> sorted privilege names. `PUBLIC` is the pseudo-role. The owner is never listed. */
export type Acl = Record<string, string[]>;

export interface SnapshotSchema {
  owner: string;
  acl: Acl;
}

export interface SnapshotTable {
  kind: 'table' | 'partitioned table';
  owner: string;
  rls: { enabled: boolean; forced: boolean };
  /** Column names in column order. */
  columns: string[];
  acl: Acl;
  /** Column -> column-level grants. Only columns that carry any. */
  column_acl: Record<string, Acl>;
}

export interface SnapshotSequence {
  owner: string;
  acl: Acl;
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface SnapshotPolicy {
  /** `schema.table`. */
  table: string;
  name: string;
  command: PolicyCommand;
  permissive: boolean;
  /** Role names, sorted; `PUBLIC` when the policy has no TO clause. */
  roles: string[];
  /** pg_get_expr() of the USING and WITH CHECK expressions. */
  using: string | null;
  with_check: string | null;
  /** Functions the policy expressions call, as manifest keys, sorted. */
  functions: string[];
}

export interface SnapshotFunction {
  owner: string;
  security: 'definer' | 'invoker';
  /** The pinned search_path exactly as proconfig stores it, or null. */
  search_path: string | null;
  language: string;
  kind: 'function' | 'procedure' | 'aggregate' | 'window';
  /** pg_get_function_identity_arguments(). */
  arguments: string;
  /** pg_get_function_result(); null for a procedure, which has none. */
  returns: string | null;
  acl: Acl;
}

export interface CatalogSnapshot {
  version: 1;
  schemas: Record<string, SnapshotSchema>;
  /** Keyed `schema.table`. */
  tables: Record<string, SnapshotTable>;
  /** Keyed `schema.sequence`. */
  sequences: Record<string, SnapshotSequence>;
  /** Keyed `schema.table.policy`. */
  policies: Record<string, SnapshotPolicy>;
  /** Keyed `schema.name(argtypes)` with format_type names. */
  functions: Record<string, SnapshotFunction>;
  /** Every `app.*` / `jale.*` setting a policy or function reads or sets, sorted. */
  guc_refs: string[];
}

/** System and extension-owned objects are never classified. */
const APP_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND n.nspname NOT LIKE 'pg\\_%'`;

const COMMANDS: Record<string, PolicyCommand> = { '*': 'ALL', r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' };

interface AclRow { grantee: string; privilege: string }

function toAcl(rows: AclRow[] | null): Acl {
  const acl: Acl = {};
  for (const row of rows ?? []) (acl[row.grantee] ??= []).push(row.privilege);
  for (const grantee of Object.keys(acl)) acl[grantee] = [...new Set(acl[grantee])].sort();
  return sortKeys(acl);
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** JSON aggregation of an ACL, excluding the owner's own entry. */
function aclJson(aclExpr: string, ownerExpr: string): string {
  return `COALESCE((SELECT json_agg(json_build_object(
              'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
              'privilege', a.privilege_type))
            FROM pg_catalog.aclexplode(${aclExpr}) a
           WHERE a.grantee <> ${ownerExpr}), '[]'::json)`;
}

const NOT_EXTENSION_MEMBER = (classid: string, objid: string) => `NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend dep
   WHERE dep.classid = '${classid}'::regclass AND dep.objid = ${objid} AND dep.deptype = 'e')`;

export async function readCatalog(client: CatalogQueryable): Promise<CatalogSnapshot> {
  const schemas = (await client.query(
    `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
            ${aclJson("COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))", 'n.nspowner')} AS acl
       FROM pg_catalog.pg_namespace n
      WHERE ${APP_SCHEMA_FILTER} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_namespace', 'n.oid')}`,
  )).rows as Array<{ name: string; owner: string; acl: AclRow[] }>;

  const tables = (await client.query(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS relkind,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner,
            c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                   ORDER BY a.attnum) AS columns,
            ${aclJson("COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))", 'c.relowner')} AS acl,
            COALESCE((SELECT json_agg(json_build_object(
                        'column', a.attname, 'grantee',
                        CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
                        'privilege', x.privilege_type))
                        FROM pg_catalog.pg_attribute a
                        CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
                       WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                         AND a.attacl IS NOT NULL AND x.grantee <> c.relowner), '[]'::json) AS column_acl
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${APP_SCHEMA_FILTER}
        AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  )).rows as Array<{
    name: string; relkind: string; owner: string; enabled: boolean; forced: boolean; columns: string[];
    acl: AclRow[]; column_acl: Array<AclRow & { column: string }>;
  }>;

  const sequences = (await client.query(
    `SELECT n.nspname || '.' || c.relname AS name, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
            ${aclJson("COALESCE(c.relacl, pg_catalog.acldefault('s', c.relowner))", 'c.relowner')} AS acl
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND ${APP_SCHEMA_FILTER}
        AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}`,
  )).rows as Array<{ name: string; owner: string; acl: AclRow[] }>;

  const functionKey = `n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'`;
  const functions = (await client.query(
    `SELECT ${functionKey} AS name, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS definer, p.proconfig AS config, l.lanname AS language, p.prokind::text AS kind,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_catalog.pg_get_function_result(p.oid) AS returns,
            ${aclJson("COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))", 'p.proowner')} AS acl,
            p.prosrc AS source
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE ${APP_SCHEMA_FILTER} AND ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}`,
  )).rows as Array<{
    name: string; owner: string; definer: boolean; config: string[] | null; language: string; kind: string;
    arguments: string; returns: string | null; acl: AclRow[]; source: string;
  }>;

  const policies = (await client.query(
    `SELECT n.nspname || '.' || c.relname AS table_name, pol.polname AS name, pol.polcmd::text AS cmd,
            pol.polpermissive AS permissive,
            CASE WHEN pol.polroles = '{0}'::oid[] THEN ARRAY['PUBLIC']::text[]
                 ELSE ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM unnest(pol.polroles) r) END AS roles,
            pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
            pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr,
            ARRAY(SELECT DISTINCT fn.nspname || '.' || fp.proname || '(' || pg_catalog.oidvectortypes(fp.proargtypes) || ')'
                    FROM pg_catalog.pg_depend d
                    JOIN pg_catalog.pg_proc fp ON fp.oid = d.refobjid
                    JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
                   WHERE d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = pol.oid
                     AND d.refclassid = 'pg_catalog.pg_proc'::regclass) AS functions
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE ${APP_SCHEMA_FILTER}`,
  )).rows as Array<{
    table_name: string; name: string; cmd: string; permissive: boolean; roles: string[];
    using_expr: string | null; check_expr: string | null; functions: string[];
  }>;

  const gucRefs = new Set<string>();
  const collect = (text: string | null) => {
    for (const m of (text ?? '').matchAll(/(?:current_setting|set_config)\(\s*'((?:app|jale)\.[a-z0-9_]+)'/g)) gucRefs.add(m[1]);
  };

  const snapshot: CatalogSnapshot = {
    version: 1,
    schemas: sortKeys(Object.fromEntries(schemas.map((s) => [s.name, { owner: s.owner, acl: toAcl(s.acl) }]))),
    tables: sortKeys(Object.fromEntries(tables.map((t) => {
      const columnAcl: Record<string, AclRow[]> = {};
      for (const entry of t.column_acl) (columnAcl[entry.column] ??= []).push(entry);
      return [t.name, {
        kind: t.relkind === 'p' ? 'partitioned table' : 'table',
        owner: t.owner,
        rls: { enabled: t.enabled, forced: t.forced },
        columns: t.columns,
        acl: toAcl(t.acl),
        column_acl: sortKeys(Object.fromEntries(Object.entries(columnAcl).map(([col, rows]) => [col, toAcl(rows)]))),
      } satisfies SnapshotTable];
    }))),
    sequences: sortKeys(Object.fromEntries(sequences.map((s) => [s.name, { owner: s.owner, acl: toAcl(s.acl) }]))),
    policies: sortKeys(Object.fromEntries(policies.map((p) => {
      collect(p.using_expr);
      collect(p.check_expr);
      return [`${p.table_name}.${p.name}`, {
        table: p.table_name,
        name: p.name,
        command: COMMANDS[p.cmd],
        permissive: p.permissive,
        roles: [...p.roles].sort(),
        using: p.using_expr,
        with_check: p.check_expr,
        functions: [...p.functions].sort(),
      } satisfies SnapshotPolicy];
    }))),
    functions: sortKeys(Object.fromEntries(functions.map((f) => {
      collect(f.source);
      const searchPath = (f.config ?? []).find((c) => c.startsWith('search_path='));
      return [f.name, {
        owner: f.owner,
        security: f.definer ? 'definer' : 'invoker',
        search_path: searchPath ? searchPath.slice('search_path='.length) : null,
        language: f.language,
        kind: ({ f: 'function', p: 'procedure', a: 'aggregate', w: 'window' } as const)[f.kind as 'f'] ?? 'function',
        arguments: f.arguments,
        returns: f.returns,
        acl: toAcl(f.acl),
      } satisfies SnapshotFunction];
    }))),
    guc_refs: [...gucRefs].sort(),
  };
  return snapshot;
}

/** Pretty JSON with every object's keys sorted: byte-identical for the same catalog. */
export function serializeSnapshot(snapshot: CatalogSnapshot): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
    }
    return value;
  };
  return `${JSON.stringify(sorted(snapshot), null, 2)}\n`;
}

/** Reads a committed snapshot file. */
export function loadSnapshot(file: string): CatalogSnapshot {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as CatalogSnapshot;
  if (raw.version !== 1) throw new Error('catalog snapshot: version must be 1');
  return raw;
}

async function main(argv: string[]): Promise<void> {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const url = process.env.JALE_TEST_DATABASE_URL;
  if (!url) throw new Error('snapshot: JALE_TEST_DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('snapshot: refusing a database that is not a local test bed');
  }
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET search_path = public');
    const text = serializeSnapshot(await readCatalog(client));
    if (out) {
      fs.writeFileSync(out, text);
    } else {
      process.stdout.write(text);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
