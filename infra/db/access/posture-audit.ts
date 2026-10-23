/**
 * posture-audit.ts -- the audit records' part of the database posture check,
 * and the change-log file it reads.
 *
 * REGISTERED in posture.ts's POSTURE_EXTENSIONS as `auditPosture`. Its reads
 * are catalog-only (pg_trigger, pg_class, pg_namespace, pg_proc, pg_roles,
 * pg_auth_members, pg_attribute), so the posture login runs them with the
 * defaults every login has. A violation names objects, never row data.
 *
 * CHECKS
 *   audit_guard_trigger      Every table in schema jale_audit carries the
 *                            guard: <table>_append_only (BEFORE UPDATE OR
 *                            DELETE, per row) and <table>_no_truncate (BEFORE
 *                            TRUNCATE, per statement), both calling
 *                            jale_audit.reject_change(), both enabled.
 *                            public.admin_audit_log carries the same two,
 *                            plus admin_audit_log_scrub (BEFORE INSERT, per
 *                            row, calling jale_audit.scrub_legacy_row()).
 *   audit_change_trigger     Every table audit-change-log.json covers carries
 *                            its four change-record triggers (AFTER INSERT,
 *                            UPDATE, DELETE, per statement, with transition
 *                            tables, and AFTER TRUNCATE), calling
 *                            jale_audit.capture_change() with the file's
 *                            arguments, all enabled; no other table carries
 *                            one.
 *   audit_table_grants       No role but the owner holds a privilege on a
 *                            relation in jale_audit, or on one of its columns.
 *   person_login_privileges  No personal operator login (a login named
 *                            jale_person_*, or one that belongs to an
 *                            operator group) holds a table, column or
 *                            sequence privilege.
 * "Enabled" means pg_trigger.tgenabled = 'O'.
 *
 * THE CHANGE-LOG FILE. infra/db/access/audit-change-log.json lists the
 * covered tables and columns, and every excluded column with its reason. The
 * migration that binds the change-record triggers carries the statements
 * this file implies (the migrations suite checks them), and the change-log
 * suite checks the file against the catalog. `auditPosture` reads it from
 * this directory when a run starts; a bundle that cannot ship the file passes
 * its parsed content to createAuditPosture instead. A file that cannot be
 * read or parsed makes the run incomplete.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson, type AccessManifest } from './access-manifest';
import type { PostureCheck, PostureExtension, PostureQueryable, PostureViolation } from './posture';

// ── The change-log file ─────────────────────────────────────

export interface ChangeLogTable {
  /** The uuid column kept in record_ids, or null when the row has no single id. */
  key: string | null;
  /** The columns that pair a row's old and new versions in an UPDATE: its primary key. */
  match: string[];
  /** The uuid columns naming users, kept in subject_user_ids. */
  subject: string[];
  /** The covered columns: a change to any of them is named in changed_fields. */
  columns: string[];
  reason: string;
}

export interface ChangeLog {
  version: 1;
  description: string;
  /** Keyed `schema.table`. */
  tables: Record<string, ChangeLogTable>;
  /** Per covered table: every column that is not covered, with the reason. */
  excluded_columns: Record<string, Record<string, string>>;
  /** Tables deliberately left out, with the reason. */
  excluded_tables: Record<string, string>;
}

export const CHANGE_LOG_FILE = 'audit-change-log.json';

const TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;
/** A name changed_fields may hold (jale_audit.changes' CHECK). */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNameList = (value: unknown, pattern: RegExp): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string' && pattern.test(v)) && new Set(value).size === value.length;
const isReason = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Validates the parsed file. Throws naming the entry at fault, never a value. */
export function parseChangeLog(raw: unknown): ChangeLog {
  const fail = (where: string, what: string): never => {
    throw new Error(`audit-change-log: ${where}: ${what}`);
  };
  if (!isRecord(raw)) fail('file', 'not an object');
  const file = raw as Record<string, unknown>;
  const known = ['version', 'description', 'tables', 'excluded_columns', 'excluded_tables'];
  for (const key of Object.keys(file)) if (!known.includes(key)) fail(key, 'unknown section');
  if (file.version !== 1) fail('version', 'must be 1');
  if (!isReason(file.description)) fail('description', 'missing');
  if (!isRecord(file.tables) || Object.keys(file.tables).length === 0) fail('tables', 'missing or empty');
  if (!isRecord(file.excluded_columns)) fail('excluded_columns', 'missing');
  if (!isRecord(file.excluded_tables)) fail('excluded_tables', 'missing');

  const tables = file.tables as Record<string, unknown>;
  for (const [name, entry] of Object.entries(tables)) {
    if (!TABLE_NAME.test(name)) fail(name, 'not a schema-qualified table name');
    if (!isRecord(entry)) fail(name, 'not an object');
    const t = entry as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (!['key', 'match', 'subject', 'columns', 'reason'].includes(key)) fail(name, `unknown field ${key}`);
    }
    if (t.key !== null && !(typeof t.key === 'string' && COLUMN_NAME.test(t.key))) fail(name, 'key must be a column name or null');
    if (!isNameList(t.match, COLUMN_NAME) || t.match.length === 0) fail(name, 'match must list the primary-key columns');
    if (typeof t.key === 'string' && !((t.match as string[]).length === 1 && (t.match as string[])[0] === t.key)) {
      fail(name, 'a key must be the whole primary key');
    }
    if (!isNameList(t.subject, COLUMN_NAME)) fail(name, 'subject must list column names');
    if (!isNameList(t.columns, FIELD_NAME) || t.columns.length === 0 || t.columns.length > 200) {
      fail(name, 'columns must list 1-200 column names');
    }
    if (!isReason(t.reason)) fail(name, 'reason missing');
  }
  for (const [name, columns] of Object.entries(file.excluded_columns as Record<string, unknown>)) {
    if (!(name in tables)) fail(`excluded_columns.${name}`, 'not a covered table');
    if (!isRecord(columns)) fail(`excluded_columns.${name}`, 'not an object');
    for (const [column, reason] of Object.entries(columns as Record<string, unknown>)) {
      if (!COLUMN_NAME.test(column)) fail(`excluded_columns.${name}`, 'not a column name');
      if (((tables[name] as ChangeLogTable).columns).includes(column)) fail(`excluded_columns.${name}.${column}`, 'also covered');
      if (!isReason(reason)) fail(`excluded_columns.${name}.${column}`, 'reason missing');
    }
  }
  for (const [name, reason] of Object.entries(file.excluded_tables as Record<string, unknown>)) {
    if (!TABLE_NAME.test(name)) fail(`excluded_tables.${name}`, 'not a schema-qualified table name');
    if (name in tables) fail(`excluded_tables.${name}`, 'also covered');
    if (!isReason(reason)) fail(`excluded_tables.${name}`, 'reason missing');
  }
  return raw as unknown as ChangeLog;
}

/** Reads and validates audit-change-log.json from `dir` (this directory by default). */
export function loadChangeLog(dir: string = __dirname): ChangeLog {
  return parseChangeLog(JSON.parse(fs.readFileSync(path.join(dir, CHANGE_LOG_FILE), 'utf8')));
}

/**
 * A stable identifier for a change log: the sha256, in hex, of its canonical
 * JSON, exactly as manifestDigest() identifies a manifest. The posture report
 * carries it, and the deploy gate compares it with the digest of the change
 * log it sent, so both sides must compute it here.
 */
export function changeLogDigest(log: ChangeLog): string {
  return createHash('sha256').update(canonicalJson(log)).digest('hex');
}

/** The events a covered table's triggers fire on: name suffix, tgtype bits and transition tables. */
export const CHANGE_TRIGGER_EVENTS = [
  { event: 'INSERT', suffix: 'insert', tgtype: 4, oldTable: null, newTable: 'new_rows' },
  { event: 'UPDATE', suffix: 'update', tgtype: 16, oldTable: 'old_rows', newTable: 'new_rows' },
  { event: 'DELETE', suffix: 'delete', tgtype: 8, oldTable: 'old_rows', newTable: null },
  { event: 'TRUNCATE', suffix: 'truncate', tgtype: 32, oldTable: null, newTable: null },
] as const;

export function changeTriggerName(table: string, suffix: string): string {
  return `${table.split('.')[1]}_audit_change_${suffix}`;
}

/** capture_change()'s four arguments: key, match columns, subject columns, covered columns. */
export function changeTriggerArgs(table: ChangeLogTable): string[] {
  return [table.key ?? '', table.match.join(','), table.subject.join(','), table.columns.join(',')];
}

// ── The posture extension ───────────────────────────────────

export interface AuditTriggerRow {
  /** `schema.table`. */
  table: string;
  name: string;
  /** pg_trigger.tgtype. */
  type: number;
  /** pg_trigger.tgenabled. */
  enabled: string;
  /** `schema.name` of the trigger function. */
  function: string;
  args: string[];
  old_table: string | null;
  new_table: string | null;
}

export interface AuditGrantRow {
  /** `schema.relation`, or `schema.relation.column`. */
  object: string;
  grantee: string;
  privilege: string;
}

export interface AuditLoginRow {
  name: string;
  /** The roles it is a member of. */
  member_of: string[];
  /** Table, column and sequence privileges granted to it in this database. */
  relation_privileges: number;
}

export interface AuditPostureRows {
  /** The relations of kind table in schema jale_audit. */
  auditTables: string[];
  /** Whether public.admin_audit_log exists. */
  legacyTable: boolean;
  /** Every trigger on a jale_audit table or on admin_audit_log, and every trigger calling a jale_audit function. */
  triggers: AuditTriggerRow[];
  grants: AuditGrantRow[];
  logins: AuditLoginRow[];
  changeLog: ChangeLog;
}

const LEGACY_TABLE = 'public.admin_audit_log';
const PERSON_LOGIN = /^jale_person_/;

/** tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. */
const GUARD_ROW = 1 | 2 | 8 | 16;
const GUARD_TRUNCATE = 2 | 32;
const SCRUB_ROW = 1 | 2 | 4;

const READS = {
  auditTables: `
    SELECT n.nspname || '.' || c.relname AS name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'jale_audit' AND c.relkind IN ('r', 'p')
     ORDER BY 1`,
  legacyTable: `SELECT pg_catalog.to_regclass('public.admin_audit_log') IS NOT NULL AS present`,
  triggers: `
    SELECT n.nspname || '.' || c.relname AS "table", t.tgname AS name, t.tgtype::int AS type,
           t.tgenabled::text AS enabled, fn.nspname || '.' || p.proname AS function,
           (pg_catalog.string_to_array(pg_catalog.encode(t.tgargs, 'escape'), '\\000'))[1:t.tgnargs] AS args,
           t.tgoldtable::text AS old_table, t.tgnewtable::text AS new_table
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
     WHERE NOT t.tgisinternal
       AND (n.nspname = 'jale_audit' OR fn.nspname = 'jale_audit'
            OR (n.nspname = 'public' AND c.relname = 'admin_audit_log'))`,
  grants: `
    SELECT n.nspname || '.' || c.relname AS object,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type AS privilege
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
           pg_catalog.aclexplode(c.relacl) a
     WHERE n.nspname = 'jale_audit' AND a.grantee <> c.relowner
    UNION ALL
    SELECT n.nspname || '.' || c.relname || '.' || att.attname,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
           a.privilege_type
      FROM pg_catalog.pg_attribute att
      JOIN pg_catalog.pg_class c ON c.oid = att.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
           pg_catalog.aclexplode(att.attacl) a
     WHERE n.nspname = 'jale_audit' AND a.grantee <> c.relowner`,
  logins: `
    SELECT r.rolname AS name,
           ARRAY(SELECT g.rolname::text FROM pg_catalog.pg_auth_members am
                   JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
                  WHERE am.member = r.oid ORDER BY 1) AS member_of,
           ((SELECT count(*) FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE a.grantee = r.oid AND a.grantee <> c.relowner)
            + (SELECT count(*) FROM pg_catalog.pg_attribute att
                 JOIN pg_catalog.pg_class c ON c.oid = att.attrelid,
                      pg_catalog.aclexplode(att.attacl) a
                WHERE a.grantee = r.oid AND a.grantee <> c.relowner))::int AS relation_privileges
      FROM pg_catalog.pg_roles r
     WHERE r.rolcanlogin AND r.rolname !~ '^pg_'`,
} as const;

/** One expected trigger. */
interface ExpectedTrigger {
  check: PostureCheck;
  table: string;
  name: string;
  type: number;
  function: string;
  args: string[];
  old_table: string | null;
  new_table: string | null;
}

function expectedGuard(rows: AuditPostureRows): ExpectedTrigger[] {
  const tables = [...rows.auditTables, ...(rows.legacyTable ? [LEGACY_TABLE] : [])];
  const out: ExpectedTrigger[] = [];
  for (const table of tables) {
    const base = table.split('.')[1];
    const guard = { check: 'audit_guard_trigger' as const, table, function: 'jale_audit.reject_change', args: [], old_table: null, new_table: null };
    out.push({ ...guard, name: `${base}_append_only`, type: GUARD_ROW });
    out.push({ ...guard, name: `${base}_no_truncate`, type: GUARD_TRUNCATE });
  }
  if (rows.legacyTable) {
    out.push({
      check: 'audit_guard_trigger', table: LEGACY_TABLE, name: 'admin_audit_log_scrub', type: SCRUB_ROW,
      function: 'jale_audit.scrub_legacy_row', args: [], old_table: null, new_table: null,
    });
  }
  return out;
}

function expectedChange(log: ChangeLog): ExpectedTrigger[] {
  const out: ExpectedTrigger[] = [];
  for (const [table, entry] of Object.entries(log.tables)) {
    for (const e of CHANGE_TRIGGER_EVENTS) {
      out.push({
        check: 'audit_change_trigger', table, name: changeTriggerName(table, e.suffix), type: e.tgtype,
        function: 'jale_audit.capture_change', args: changeTriggerArgs(entry), old_table: e.oldTable, new_table: e.newTable,
      });
    }
  }
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function compare(a: PostureViolation, b: PostureViolation): number {
  for (const key of ['check', 'object', 'detail'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  return 0;
}

/** Pure: the four audit checks. */
export function evaluateAuditPosture(rows: AuditPostureRows, manifest: AccessManifest): PostureViolation[] {
  const out: PostureViolation[] = [];
  const add = (check: PostureCheck, object: string, detail: string) => out.push({ check, object, detail });

  if (rows.auditTables.length === 0) add('audit_guard_trigger', 'jale_audit', 'no audit tables in the catalog');
  if (!rows.legacyTable) add('audit_guard_trigger', LEGACY_TABLE, 'missing from the catalog');

  const expected = [...expectedGuard(rows), ...expectedChange(rows.changeLog)];
  const found = new Map(rows.triggers.map((t) => [`${t.table} ${t.name}`, t]));
  for (const want of expected) {
    const object = `${want.table}.${want.name}`;
    const got = found.get(`${want.table} ${want.name}`);
    if (!got) { add(want.check, object, 'missing'); continue; }
    if (got.enabled !== 'O') add(want.check, object, `not enabled (tgenabled ${got.enabled})`);
    if (got.type !== want.type) add(want.check, object, 'fires on the wrong events or timing');
    if (got.function !== want.function) add(want.check, object, `calls ${got.function}`);
    if (!sameList(got.args, want.args)) add(want.check, object, 'arguments differ from the expected ones');
    if (got.old_table !== want.old_table || got.new_table !== want.new_table) add(want.check, object, 'transition tables differ');
  }
  const wanted = new Set(expected.map((t) => `${t.table} ${t.name}`));
  for (const t of rows.triggers) {
    if (wanted.has(`${t.table} ${t.name}`)) continue;
    if (t.function === 'jale_audit.capture_change') add('audit_change_trigger', `${t.table}.${t.name}`, 'not in the change-log file');
    else if (t.function === 'jale_audit.reject_change') add('audit_guard_trigger', `${t.table}.${t.name}`, 'not an expected guard trigger');
  }

  for (const g of rows.grants) add('audit_table_grants', g.object, `${g.grantee} holds ${g.privilege}`);

  const groups = new Set(Object.keys(manifest.groups));
  for (const login of rows.logins) {
    const person = PERSON_LOGIN.test(login.name) || login.member_of.some((g) => groups.has(g));
    if (person && login.relation_privileges > 0) {
      add('person_login_privileges', login.name,
        `holds ${login.relation_privileges} table, column or sequence privilege${login.relation_privileges === 1 ? '' : 's'}`);
    }
  }
  return out.sort(compare);
}

/** The extension, reading the change-log file through `changeLog` when a run starts. */
export function createAuditPosture(changeLog: () => ChangeLog = () => loadChangeLog()): PostureExtension<AuditPostureRows> {
  return {
    name: 'audit',
    async read(client: PostureQueryable): Promise<AuditPostureRows> {
      const log = changeLog();
      const auditTables = ((await client.query(READS.auditTables)).rows as Array<{ name: string }>).map((r) => r.name);
      const legacy = (await client.query(READS.legacyTable)).rows as Array<{ present: boolean }>;
      const triggers = (await client.query(READS.triggers)).rows as AuditTriggerRow[];
      const grants = (await client.query(READS.grants)).rows as AuditGrantRow[];
      const logins = (await client.query(READS.logins)).rows as AuditLoginRow[];
      return { auditTables, legacyTable: legacy[0]?.present === true, triggers, grants, logins, changeLog: log };
    },
    evaluate: evaluateAuditPosture,
  };
}

export const auditPosture = createAuditPosture();
