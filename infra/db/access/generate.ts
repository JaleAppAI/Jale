/**
 * generate.ts -- writes the access-rights migration from the access manifest
 * and a catalog snapshot of a test bed taken before that migration.
 *
 * The output is plain SQL that a reviewer reads like any other migration:
 *   - table and column grants for the dedicated logins;
 *   - the reviewed policy copies (`<source>__<code>`) and the new policies
 *     the manifest defines;
 *   - EXECUTE and schema USAGE. Objects owned by a NOLOGIN helper role are
 *     granted inside an INHERIT-only window that the migration closes again
 *     before it commits; there is no SET ROLE;
 *   - a self-audit that compares, per login, the counts of policies, grants
 *     and EXECUTEs with constants written here, proves every copy is
 *     byte-equal to its source, and refuses to apply when a source policy
 *     changed since the snapshot.
 *
 * It is deterministic: everything is sorted, nothing depends on time, and
 * the same manifest and snapshot always give byte-identical SQL.
 *
 * 106 is generated from manifest.json ALONE. A later change's manifest.d
 * fragment writes its rights in its own migration and only mirrors them in
 * the fragment, so a fragment never changes 106. The generator checks only
 * what 106 touches (copy sources, and the tables, columns, schemas,
 * functions and sequences it grants on); whole-catalog classification is the
 * coverage guard's job.
 *
 * Usage (dev time):
 *   npx tsx infra/db/access/generate.ts            write the migration
 *   npx tsx infra/db/access/generate.ts --check    exit 1 if the file differs
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseManifest,
  readManifestFiles,
  type AccessManifest,
  type ColumnSet,
  type PolicyCommand,
  type PolicyEntry,
  type TableLoginAccess,
} from './access-manifest';
import { loadSnapshot, type CatalogSnapshot, type SnapshotPolicy } from './snapshot';

/** The suffix a copied policy carries, per login. */
export const COPY_CODES: Readonly<Record<string, string>> = Object.freeze({ jale_api: 'api', jale_job_digest: 'dg' });

/** The only unrestricted policies a runtime login may receive as copies: reference data. */
export const OPEN_COPY_ALLOW_LIST: readonly string[] = Object.freeze([
  'billing_plans_read_all',
  'city_cbsa_crosswalk_read_all',
  'wage_references_read_all',
]);

/** Policies that are never copied to a runtime login, whatever the manifest says. */
const NEVER_COPIED: readonly RegExp[] = [
  /_definer$/, /admin_analytics/, /_capture_insert$/, /reconcile/, /backfill/, /reset_audit/, /_service_all$/,
  /^email_outbox_admin_/, /^job_visibility_events_drain_update$/, /^wa_conv_admin$/, /^job_share_links_claim_read$/,
];

/** The caller-identity settings. Any other app.* or jale.* setting in a source policy is a capability flag. */
const IDENTITY_SETTINGS: ReadonlySet<string> = new Set(['app.current_user_id', 'app.current_internal_user_id']);

export interface MigrationInfo {
  number: string;
  file: string;
  previous: string;
}

export interface GenerateInput {
  manifest: AccessManifest;
  snapshot: CatalogSnapshot;
  /** The logins this migration grants to. */
  logins: readonly string[];
  migration: MigrationInfo;
}

const SIMPLE_IDENT = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(['all', 'user', 'table', 'select', 'insert', 'update', 'delete', 'order', 'group', 'check', 'default']);

export function quoteIdent(name: string): string {
  return SIMPLE_IDENT.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function qualified(key: string): string {
  return key.split('.').map(quoteIdent).join('.');
}

function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** A dollar-quoted literal whose tag does not occur in the text. */
function dollarLiteral(text: string): string {
  let tag = 'src';
  while (text.includes(`$${tag}$`)) tag = `${tag}x`;
  return `$${tag}$${text}$${tag}$`;
}

/** `items`, comma-separated, wrapped into comment lines of at most 78 characters. */
function wrapList(items: readonly string[], prefix: string): string[] {
  const lines: string[] = [];
  let line = prefix;
  items.forEach((item, index) => {
    const piece = `${item}${index < items.length - 1 ? ',' : '.'}`;
    if (line !== prefix && line.length + 1 + piece.length > 78) {
      lines.push(line);
      line = prefix;
    }
    line = line === prefix ? `${prefix}${piece}` : `${line} ${piece}`;
  });
  lines.push(line);
  return lines;
}

/** A section heading in the style of the hand-written migrations. */
function heading(title: string): string {
  const text = `-- ── ${title} `;
  return `${text}${'─'.repeat(Math.max(3, 62 - text.length))}`;
}

function columnsSql(columns: ColumnSet): string {
  return columns === '*' ? '' : ` (${[...columns].map(quoteIdent).join(', ')})`;
}

function byKey<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A reviewed copy of an existing policy, for one dedicated login. */
export interface PolicyCopy {
  /** The table, schema-qualified. */
  table: string;
  /** The copy's own name: `<copyOf>__<code>`. */
  name: string;
  /** The policy it copies, on the same table. */
  copyOf: string;
  command: PolicyCommand;
  to: string[];
}

/**
 * Every reviewed copy the manifest records, in key order. The generator writes
 * exactly these, and the DB suites that assert a table's exact policy set read
 * them from here (infra/test/unit/db/helpers/policy-copies.ts), so there is one
 * list of copies.
 */
export function policyCopies(manifest: AccessManifest): PolicyCopy[] {
  return byKey(manifest.policies)
    .filter(([, policy]) => policy.origin === 'copy')
    .map(([key, policy]) => {
      const [schema, table, name] = key.split('.');
      return { table: `${schema}.${table}`, name, copyOf: policy.copy_of!, command: policy.command, to: [...policy.to] };
    });
}

interface TableGrant { table: string; login: string; privilege: string; columns: ColumnSet }

function tableGrants(access: TableLoginAccess, table: string, login: string): TableGrant[] {
  const out: TableGrant[] = [];
  if (access.select) out.push({ table, login, privilege: 'SELECT', columns: access.select });
  if (access.insert) out.push({ table, login, privilege: 'INSERT', columns: access.insert });
  if (access.update) out.push({ table, login, privilege: 'UPDATE', columns: access.update });
  if (access.delete) out.push({ table, login, privilege: 'DELETE', columns: '*' });
  return out;
}

function settingsIn(text: string | null): string[] {
  return [...(text ?? '').matchAll(/current_setting\('((?:app|jale)\.[a-z0-9_]+)'/g)].map((m) => m[1]);
}

/** Everything the generator refuses, reported at once. */
export function validateForGeneration(input: GenerateInput): string[] {
  const { manifest, snapshot, logins } = input;
  const problems: string[] = [];
  const targets = new Set(logins);

  for (const login of logins) {
    if (!(login in manifest.logins)) problems.push(`login ${login} is not in the manifest`);
  }

  for (const [table, entry] of byKey(manifest.tables)) {
    for (const [login, access] of byKey(entry.access)) {
      if (!targets.has(login)) continue;
      const snap = snapshot.tables[table];
      if (!snap) { problems.push(`tables.${table}: unknown table`); continue; }
      if (entry.classification === 'excluded') problems.push(`tables.${table}: excluded but grants to ${login}`);
      if (access.truncate || access.references || access.trigger) {
        problems.push(`tables.${table}.access.${login}: TRUNCATE, REFERENCES and TRIGGER are never granted to a dedicated login`);
      }
      for (const field of ['select', 'insert', 'update'] as const) {
        const cols = access[field];
        if (Array.isArray(cols)) {
          for (const col of cols) {
            if (!snap.columns.includes(col)) problems.push(`tables.${table}.access.${login}.${field}: unknown column ${col}`);
          }
        }
      }
    }
  }

  const existingNames = new Set(Object.keys(snapshot.policies));
  for (const [key, policy] of byKey(manifest.policies)) {
    if (policy.origin === 'existing') continue;
    const outsiders = policy.to.filter((role) => !targets.has(role));
    if (outsiders.length > 0) problems.push(`policies.${key}: a generated policy may only apply to ${[...targets].sort().join(', ')}`);
    const [schema, table, name] = key.split('.');
    const tableKey = `${schema}.${table}`;
    if (!snapshot.tables[tableKey]) problems.push(`policies.${key}: unknown table ${tableKey}`);
    if (Buffer.byteLength(name, 'utf8') > 63) problems.push(`policies.${key}: name longer than 63 bytes`);
    if (existingNames.has(key)) problems.push(`policies.${key}: collides with an existing policy`);
    if (policy.origin === 'copy') {
      const sourceKey = `${tableKey}.${policy.copy_of}`;
      const source = snapshot.policies[sourceKey];
      if (!source) { problems.push(`policies.${key}: unknown source ${sourceKey}`); continue; }
      const login = policy.to.length === 1 ? policy.to[0] : undefined;
      const code = login ? COPY_CODES[login] : undefined;
      if (!code) {
        problems.push(`policies.${key}: a copy applies to exactly one login with a copy code`);
      } else if (name !== `${policy.copy_of}__${code}`) {
        problems.push(`policies.${key}: a copy of ${policy.copy_of} for ${login} must be named ${policy.copy_of}__${code}`);
      }
      if (policy.command !== source.command || policy.permissive !== source.permissive) {
        problems.push(`policies.${key}: command and mode must match the source ${sourceKey}`);
      }
      if (NEVER_COPIED.some((pattern) => pattern.test(source.name))) {
        problems.push(`policies.${key}: ${source.name} is never copied to a runtime login`);
      }
      const flags = [...settingsIn(source.using), ...settingsIn(source.with_check)].filter((s) => !IDENTITY_SETTINGS.has(s));
      if (flags.length > 0) problems.push(`policies.${key}: the source reads capability setting ${[...new Set(flags)].join(', ')}`);
      const open = [source.using, source.with_check].some((e) => (e ?? '').trim() === 'true');
      if (open && !OPEN_COPY_ALLOW_LIST.includes(source.name)) {
        problems.push(`policies.${key}: ${source.name} is unrestricted and not on the reference-data allow-list`);
      }
      // A copy must be scoped to the caller: its source names a caller
      // identity setting, however else it is written (`(true)`, `1 = 1`,
      // `revoked_at IS NULL` all open a table to every caller). Reference data
      // on the allow-list is the only exception.
      const identity = [...settingsIn(source.using), ...settingsIn(source.with_check)].some((s) => IDENTITY_SETTINGS.has(s));
      if (!identity && !open && !OPEN_COPY_ALLOW_LIST.includes(source.name)) {
        problems.push(`policies.${key}: ${source.name} names no caller identity setting and is not on the reference-data allow-list`);
      }
      if (open !== (policy.open === true)) problems.push(`policies.${key}: open must be ${open} to match its source`);
    } else {
      const open = [policy.using, policy.with_check].some((e) => (e ?? '').trim() === 'true');
      if (open) {
        for (const login of policy.to) {
          if (manifest.logins[login]?.kind !== 'job') {
            problems.push(`policies.${key}: an unrestricted new policy is allowed for job logins only`);
          }
        }
      }
    }
  }

  for (const [fn, entry] of byKey(manifest.functions)) {
    if (entry.created_by === '105') continue;
    if (!entry.execute.some((role) => targets.has(role))) continue;
    if (!snapshot.functions[fn]) problems.push(`functions.${fn}: unknown function`);
  }
  for (const [schema, entry] of byKey(manifest.schemas)) {
    if (![...entry.usage, ...entry.create].some((role) => targets.has(role))) continue;
    if (!snapshot.schemas[schema]) problems.push(`schemas.${schema}: unknown schema`);
    if (entry.create.some((role) => targets.has(role))) problems.push(`schemas.${schema}: CREATE is never granted to a dedicated login`);
  }
  for (const [sequence, entry] of byKey(manifest.sequences)) {
    if (![...entry.usage, ...entry.select, ...entry.update].some((role) => targets.has(role))) continue;
    if (!snapshot.sequences[sequence]) problems.push(`sequences.${sequence}: unknown sequence`);
  }
  return problems;
}

function policySql(key: string, policy: PolicyEntry, source: SnapshotPolicy | undefined): string {
  const [schema, table, name] = key.split('.');
  const using = policy.origin === 'copy' ? source!.using : policy.using ?? null;
  const withCheck = policy.origin === 'copy' ? source!.with_check : policy.with_check ?? null;
  const lines = [
    `DROP POLICY IF EXISTS ${quoteIdent(name)} ON ${quoteIdent(schema)}.${quoteIdent(table)};`,
    `CREATE POLICY ${quoteIdent(name)} ON ${quoteIdent(schema)}.${quoteIdent(table)}`,
    `  AS ${policy.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${policy.command} TO ${policy.to.map(quoteIdent).join(', ')}`,
  ];
  if (using !== null) lines.push(`  USING (${using})`);
  if (withCheck !== null) lines.push(`  WITH CHECK (${withCheck})`);
  lines[lines.length - 1] += ';';
  return lines.join('\n');
}

interface LoginCounts {
  policies: number;
  tablePrivileges: number;
  columnPrivileges: number;
  sequencePrivileges: number;
  executes: number;
  schemaPrivileges: number;
}

/** The final state the manifest describes for one login, as catalog counts. */
export function expectedCounts(manifest: AccessManifest, login: string): LoginCounts {
  let tablePrivileges = 0;
  let columnPrivileges = 0;
  for (const entry of Object.values(manifest.tables)) {
    const access = entry.access[login];
    if (!access) continue;
    for (const field of ['select', 'insert', 'update'] as const) {
      const cols = access[field];
      if (cols === '*') tablePrivileges += 1;
      else if (Array.isArray(cols)) columnPrivileges += cols.length;
    }
    if (access.delete) tablePrivileges += 1;
  }
  const policies = Object.values(manifest.policies).filter((p) => p.to.includes(login)).length;
  const sequencePrivileges = Object.values(manifest.sequences)
    .reduce((n, q) => n + [q.usage, q.select, q.update].filter((roles) => roles.includes(login)).length, 0);
  const executes = Object.values(manifest.functions).filter((f) => f.execute.includes(login)).length;
  const schemaPrivileges = Object.values(manifest.schemas)
    .reduce((n, s) => n + (s.usage.includes(login) ? 1 : 0) + (s.create.includes(login) ? 1 : 0), 0);
  return { policies, tablePrivileges, columnPrivileges, sequencePrivileges, executes, schemaPrivileges };
}

export function generateAccessRights(input: GenerateInput): string {
  const problems = validateForGeneration(input);
  if (problems.length > 0) throw new Error(`generate: ${problems.join('; ')}`);
  const { manifest, snapshot, migration } = input;
  const logins = [...input.logins].sort();
  const targets = new Set(logins);
  const out: string[] = [];

  out.push(
    '-- ============================================================',
    `-- ${migration.file}`,
    `-- Run manually AFTER ${migration.previous},`,
    '-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.',
    '--',
    '-- GENERATED by infra/db/access/generate.ts from infra/db/access/manifest.json',
    '-- and the catalog snapshot infra/db/access/catalog-snapshot.json. Do not',
    '-- edit by hand: change the manifest, then regenerate.',
    '--',
    '-- Least-privilege database access, part 3 of 3: the reviewed access rights',
    '-- of the dedicated logins',
    ...wrapList(logins, '--   '),
    '-- in four parts:',
    '--   1. table and column grants;',
    '--   2. the copied request policies (<source>__<code>) and the new policies',
    '--      the manifest defines, each dropped first so a rerun is safe;',
    '--   3. EXECUTE and schema USAGE. Objects owned by a NOLOGIN helper role are',
    '--      granted inside an INHERIT-only membership window: the grant runs as',
    '--      though the owner issued it, and the window holds GRANT statements',
    '--      only. It is closed again, and audited closed, before COMMIT;',
    '--   4. a self-audit: per-login counts of policies, grants and EXECUTEs, copy',
    '--      fidelity against each source, and a refusal to apply when a source',
    '--      policy changed since the snapshot.',
    '--',
    '-- DEPLOY ORDER: apply after 105 and BEFORE the release deploy. The previous',
    '-- release never connects as these logins, so it keeps working unchanged.',
    '--',
    '-- REPLAY. Safe: grants are idempotent and every policy is dropped before it',
    '-- is created. The self-audit re-proves the result either way.',
    '-- ============================================================',
    'BEGIN;',
    '',
    "SET LOCAL lock_timeout = '5s';",
    '-- DROP POLICY IF EXISTS notices on a first apply are expected; keep the log quiet.',
    'SET LOCAL client_min_messages = warning;',
    '-- The copied expressions were read with this search_path; parsing them under',
    '-- the same one keeps every name resolving to the same object.',
    'SET LOCAL search_path = public;',
    '',
    'DO $$',
    'BEGIN',
    "  IF pg_catalog.to_regnamespace('jale_cap') IS NULL",
    "     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace = pg_catalog.to_regnamespace('jale_cap')) THEN",
    `    RAISE EXCEPTION 'migration ${migration.number}: apply 105 first (jale_cap holds no functions)';`,
    '  END IF;',
    `  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (ARRAY[${logins.map(sqlLiteral).join(', ')}])) <> ${logins.length} THEN`,
    `    RAISE EXCEPTION 'migration ${migration.number}: apply 104 first (a dedicated login is missing)';`,
    '  END IF;',
    'END;',
    '$$;',
    '',
  );

  // 1. Table and column grants.
  out.push(heading('1. Table and column grants'));
  for (const [table, entry] of byKey(manifest.tables)) {
    for (const [login, access] of byKey(entry.access)) {
      if (!targets.has(login)) continue;
      for (const grant of tableGrants(access, table, login)) {
        out.push(`GRANT ${grant.privilege}${columnsSql(grant.columns)} ON ${qualified(table)} TO ${quoteIdent(login)};`);
      }
    }
  }
  out.push('');

  // Sequences.
  const sequenceGrants: string[] = [];
  for (const [sequence, entry] of byKey(manifest.sequences)) {
    for (const [privilege, roles] of [['USAGE', entry.usage], ['SELECT', entry.select], ['UPDATE', entry.update]] as const) {
      const granted = roles.filter((role) => targets.has(role)).sort();
      if (granted.length > 0) sequenceGrants.push(`GRANT ${privilege} ON SEQUENCE ${qualified(sequence)} TO ${granted.map(quoteIdent).join(', ')};`);
    }
  }
  if (sequenceGrants.length > 0) out.push(heading('Sequence grants'), ...sequenceGrants, '');

  // 2. Policies.
  out.push(heading('2. Policies'));
  const generated = byKey(manifest.policies).filter(([, p]) => p.origin !== 'existing');
  for (const [key, policy] of generated) {
    const [schema, table] = key.split('.');
    const source = policy.origin === 'copy' ? snapshot.policies[`${schema}.${table}.${policy.copy_of}`] : undefined;
    out.push(policySql(key, policy, source), '');
  }

  // 3. EXECUTE and USAGE, grouped by the owner of the object.
  const grantsByOwner = new Map<string, string[]>();
  const addGrant = (owner: string, sql: string) => {
    if (!grantsByOwner.has(owner)) grantsByOwner.set(owner, []);
    grantsByOwner.get(owner)!.push(sql);
  };
  for (const [schema, entry] of byKey(manifest.schemas)) {
    const granted = entry.usage.filter((role) => targets.has(role)).sort();
    if (granted.length > 0) addGrant(entry.owner, `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${granted.map(quoteIdent).join(', ')};`);
  }
  for (const [fn, entry] of byKey(manifest.functions)) {
    if (entry.created_by === '105') continue;
    const granted = entry.execute.filter((role) => targets.has(role)).sort();
    if (granted.length === 0) continue;
    const open = fn.indexOf('(');
    const signature = `${qualified(fn.slice(0, open))}${fn.slice(open)}`;
    const kind = entry.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    addGrant(entry.owner, `GRANT EXECUTE ON ${kind} ${signature} TO ${granted.map(quoteIdent).join(', ')};`);
  }
  out.push(heading('3. EXECUTE and schema USAGE'));
  const master = manifest.master;
  const helperOwners = [...grantsByOwner.keys()].filter((owner) => owner !== master).sort();
  out.push(...(grantsByOwner.get(master) ?? []), '');
  for (const owner of helperOwners) {
    out.push(
      `-- Owned by ${owner}: an INHERIT-only window, GRANT statements only.`,
      'DO $$',
      'BEGIN',
      `  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', ${sqlLiteral(owner)}, current_user);`,
      'END;',
      '$$;',
      ...grantsByOwner.get(owner)!,
      'DO $$',
      'BEGIN',
      `  EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET FALSE', ${sqlLiteral(owner)}, current_user);`,
      `  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', ${sqlLiteral(owner)}, current_user, current_user);`,
      'END;',
      '$$;',
      '',
    );
  }

  // 4. Self-audit.
  out.push(heading('4. Self-audit'));
  out.push(
    'DO $$',
    'DECLARE',
    '  spec RECORD;',
    '  actual RECORD;',
    'BEGIN',
    '  FOR spec IN',
    '    SELECT * FROM (VALUES',
  );
  const countRows = logins.map((login) => {
    const c = expectedCounts(manifest, login);
    return `      (${sqlLiteral(login)}, ${c.policies}, ${c.tablePrivileges}, ${c.columnPrivileges}, ${c.sequencePrivileges}, ${c.executes}, ${c.schemaPrivileges})`;
  });
  out.push(countRows.join(',\n'));
  out.push(
    '    ) AS t(login, policies, table_privileges, column_privileges, sequence_privileges, executes, schema_privileges)',
    '  LOOP',
    '    SELECT',
    '      (SELECT count(*) FROM pg_catalog.pg_policy pol',
    '        WHERE (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login) = ANY (pol.polroles)) AS policies,',
    '      (SELECT count(*) FROM pg_catalog.pg_class c',
    '         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    '         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a',
    "        WHERE c.relkind IN ('r', 'p') AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)) AS table_privileges,",
    '      (SELECT count(*) FROM pg_catalog.pg_attribute att',
    '         JOIN pg_catalog.pg_class c ON c.oid = att.attrelid',
    '         CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a',
    "        WHERE c.relkind IN ('r', 'p') AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)) AS column_privileges,",
    '      (SELECT count(*) FROM pg_catalog.pg_class c',
    '         CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a',
    "        WHERE c.relkind = 'S' AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)) AS sequence_privileges,",
    '      (SELECT count(*) FROM pg_catalog.pg_proc p',
    '         CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a',
    "        WHERE a.privilege_type = 'EXECUTE' AND a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)) AS executes,",
    '      (SELECT count(*) FROM pg_catalog.pg_namespace n',
    '         CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a',
    '        WHERE a.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)) AS schema_privileges',
    '    INTO actual;',
    '    IF actual.policies <> spec.policies OR actual.table_privileges <> spec.table_privileges',
    '       OR actual.column_privileges <> spec.column_privileges OR actual.sequence_privileges <> spec.sequence_privileges',
    '       OR actual.executes <> spec.executes OR actual.schema_privileges <> spec.schema_privileges THEN',
    `      RAISE EXCEPTION 'migration ${migration.number}: % holds % policies, % table, % column, % sequence, % EXECUTE and % schema privileges; the manifest says % / % / % / % / % / %',`,
    '        spec.login, actual.policies, actual.table_privileges, actual.column_privileges, actual.sequence_privileges,',
    '        actual.executes, actual.schema_privileges, spec.policies, spec.table_privileges, spec.column_privileges,',
    '        spec.sequence_privileges, spec.executes, spec.schema_privileges;',
    '    END IF;',
    '  END LOOP;',
    'END;',
    '$$;',
    '',
  );

  // Copy fidelity and source drift.
  const copies = policyCopies(manifest);
  if (copies.length > 0) {
    out.push(
      '-- Copy fidelity: every copy is byte-equal to its source; and refuse to apply',
      '-- when a source policy changed since the catalog snapshot.',
      'DO $$',
      'DECLARE',
      '  spec RECORD;',
      '  src RECORD;',
      '  dst RECORD;',
      'BEGIN',
      '  FOR spec IN',
      '    SELECT * FROM (VALUES',
    );
    const rows = copies.map((copy) => {
      const source = snapshot.policies[`${copy.table}.${copy.copyOf}`];
      const lit = (v: string | null) => (v === null ? 'NULL::text' : dollarLiteral(v));
      return `      (${sqlLiteral(copy.table)}, ${sqlLiteral(copy.copyOf)}, ${sqlLiteral(copy.name)}, ${lit(source.using)}, ${lit(source.with_check)})`;
    });
    out.push(rows.join(',\n'));
    out.push(
      '    ) AS t(table_name, source_name, copy_name, snapshot_using, snapshot_check)',
      '  LOOP',
      '    SELECT pol.polcmd, pol.polpermissive,',
      '           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,',
      '           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr',
      '      INTO src FROM pg_catalog.pg_policy pol',
      '     WHERE pol.polrelid = spec.table_name::regclass AND pol.polname = spec.source_name;',
      '    IF NOT FOUND OR src.using_expr IS DISTINCT FROM spec.snapshot_using OR src.check_expr IS DISTINCT FROM spec.snapshot_check THEN',
      `      RAISE EXCEPTION 'migration ${migration.number}: source policy % on % changed since the catalog snapshot; regenerate', spec.source_name, spec.table_name;`,
      '    END IF;',
      '    SELECT pol.polcmd, pol.polpermissive,',
      '           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,',
      '           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr',
      '      INTO dst FROM pg_catalog.pg_policy pol',
      '     WHERE pol.polrelid = spec.table_name::regclass AND pol.polname = spec.copy_name;',
      '    IF NOT FOUND OR dst.polcmd <> src.polcmd OR dst.polpermissive <> src.polpermissive',
      '       OR dst.using_expr IS DISTINCT FROM src.using_expr OR dst.check_expr IS DISTINCT FROM src.check_expr THEN',
      `      RAISE EXCEPTION 'migration ${migration.number}: copy % on % differs from its source %', spec.copy_name, spec.table_name, spec.source_name;`,
      '    END IF;',
      '  END LOOP;',
      'END;',
      '$$;',
      '',
    );
  }

  if (helperOwners.length > 0) {
    out.push(
      'DO $$',
      'BEGIN',
      '  IF EXISTS (',
      '    SELECT 1 FROM pg_catalog.pg_auth_members am',
      '     JOIN pg_catalog.pg_roles g ON g.oid = am.roleid',
      `     WHERE g.rolname = ANY (ARRAY[${helperOwners.map(sqlLiteral).join(', ')}])`,
      '       AND (am.inherit_option OR am.set_option)',
      '  ) THEN',
      `    RAISE EXCEPTION 'migration ${migration.number}: a membership window on a helper owner is still open';`,
      '  END IF;',
      'END;',
      '$$;',
      '',
    );
  }

  out.push('COMMIT;', '');
  return out.join('\n');
}

export const MIGRATION_106: MigrationInfo = Object.freeze({
  number: '106',
  file: '106_least_privilege_access_rights.sql',
  previous: '105_least_privilege_capability_functions.sql',
});

/** The logins migration 106 grants to: every login migration 104 creates. */
export function loginsFor106(manifest: AccessManifest): string[] {
  return Object.entries(manifest.logins)
    .filter(([, entry]) => entry.created_by === '104')
    .map(([name]) => name)
    .sort();
}

/** manifest.json alone, validated: never a fragment. */
export function baseManifest(dir: string = __dirname): AccessManifest {
  return parseManifest(readManifestFiles(dir).base);
}

/**
 * Migration 106's text, from `dir`'s manifest.json (never its fragments) and
 * catalog-snapshot.json. `dir` defaults to this module's directory.
 */
export function generate106(options: { dir?: string; snapshot?: CatalogSnapshot } = {}): string {
  const dir = options.dir ?? __dirname;
  const manifest = baseManifest(dir);
  const snapshot = options.snapshot ?? loadSnapshot(path.join(dir, 'catalog-snapshot.json'));
  return generateAccessRights({ manifest, snapshot, logins: loginsFor106(manifest), migration: MIGRATION_106 });
}

function main(argv: string[]): void {
  const target = path.join(__dirname, '..', 'migrations', MIGRATION_106.file);
  const text = generate106();
  if (argv.includes('--check')) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== text) {
      process.stderr.write(`${MIGRATION_106.file} is out of date; run npx tsx infra/db/access/generate.ts\n`);
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(target, text);
}

if (require.main === module) main(process.argv.slice(2));
