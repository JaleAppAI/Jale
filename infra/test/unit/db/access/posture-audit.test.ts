/**
 * posture-audit.test.ts -- the audit checks of the posture run, without a
 * database, and the change-log file they read.
 *
 * A clean catalog, built here from the change-log file and the audit tables,
 * gives no violation; each fault the checks exist for is named once. The
 * catalog queries themselves are proven on a real bed by
 * audit-posture.integration.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadManifest } from '../../../../db/access/access-manifest';
import {
  CHANGE_TRIGGER_EVENTS, auditPosture, changeTriggerArgs, changeTriggerName, createAuditPosture, evaluateAuditPosture,
  loadChangeLog, parseChangeLog, type AuditPostureRows, type AuditTriggerRow, type ChangeLog,
} from '../../../../db/access/posture-audit';
import type { PostureQueryable } from '../../../../db/access/posture';

const manifest = loadManifest();
const changeLog = loadChangeLog();
const AUDIT_TABLES = ['jale_audit.changes', 'jale_audit.events', 'jale_audit.export_batches', 'jale_audit.export_holds',
  'jale_audit.export_state'];

const trigger = (table: string, name: string, type: number, fn: string, extra: Partial<AuditTriggerRow> = {}): AuditTriggerRow => ({
  table, name, type, enabled: 'O', function: fn, args: [], old_table: null, new_table: null, ...extra,
});

/** The rows a correct database shows. */
function cleanRows(log: ChangeLog = changeLog): AuditPostureRows {
  const triggers: AuditTriggerRow[] = [];
  for (const table of [...AUDIT_TABLES, 'public.admin_audit_log']) {
    const base = table.split('.')[1];
    triggers.push(trigger(table, `${base}_append_only`, 27, 'jale_audit.reject_change'));
    triggers.push(trigger(table, `${base}_no_truncate`, 34, 'jale_audit.reject_change'));
  }
  triggers.push(trigger('public.admin_audit_log', 'admin_audit_log_scrub', 7, 'jale_audit.scrub_legacy_row'));
  for (const [table, entry] of Object.entries(log.tables)) {
    for (const e of CHANGE_TRIGGER_EVENTS) {
      triggers.push(trigger(table, changeTriggerName(table, e.suffix), e.tgtype, 'jale_audit.capture_change', {
        args: changeTriggerArgs(entry), old_table: e.oldTable, new_table: e.newTable,
      }));
    }
  }
  return {
    auditTables: [...AUDIT_TABLES],
    legacyTable: true,
    triggers,
    grants: [],
    logins: [
      { name: 'jale_api', member_of: [], relation_privileges: 40 },
      { name: 'jale_person_ana', member_of: ['jale_ops_readonly'], relation_privileges: 0 },
    ],
    changeLog: log,
  };
}

const withTrigger = (rows: AuditPostureRows, table: string, name: string, change: Partial<AuditTriggerRow> | null): AuditPostureRows => ({
  ...rows,
  triggers: rows.triggers.flatMap((t) => (t.table === table && t.name === name ? (change ? [{ ...t, ...change }] : []) : [t])),
});

describe('the change-log file', () => {
  it('the repo file is valid and covers the sixteen tables', () => {
    expect(Object.keys(changeLog.tables)).toHaveLength(16);
    expect(changeLog.tables['public.users'].columns).toContain('email');
  });

  it('names each trigger and its four arguments', () => {
    expect(changeTriggerName('public.worker_skills', 'update')).toBe('worker_skills_audit_change_update');
    expect(changeTriggerArgs(changeLog.tables['public.worker_skills'])).toEqual(['', 'worker_id,skill', 'worker_id', 'skill']);
    expect(changeTriggerArgs(changeLog.tables['public.admin_users'])[2]).toBe('');
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Raw = Record<string, any>;
  const base = () => JSON.parse(JSON.stringify(changeLog)) as Raw;
  it.each([
    ['an unknown section', (f: Raw) => { f.extra = {}; }, /extra: unknown section/],
    ['a table name without its schema', (f: Raw) => { f.tables.users = f.tables['public.users']; }, /users: not a schema-qualified/],
    ['a key that is not the whole primary key', (f: Raw) => { f.tables['public.users'].match = ['id', 'email']; }, /a key must be the whole primary key/],
    ['a covered column changed_fields cannot hold', (f: Raw) => { f.tables['public.users'].columns.push('Email'); }, /columns must list/],
    ['no covered column', (f: Raw) => { f.tables['public.users'].columns = []; }, /columns must list/],
    ['a column both covered and excluded', (f: Raw) => { f.excluded_columns['public.users'].email = 'x'; }, /email: also covered/],
    ['an excluded column without a reason', (f: Raw) => { f.excluded_columns['public.users'].city = ' '; }, /city: reason missing/],
    ['a table both covered and excluded', (f: Raw) => { f.excluded_tables['public.users'] = 'x'; }, /public\.users: also covered/],
    ['a covered table without a reason', (f: Raw) => { f.tables['public.users'].reason = ''; }, /public\.users: reason missing/],
  ])('refuses %s', (_label, mutate, message) => {
    const f = base();
    mutate(f);
    expect(() => parseChangeLog(f)).toThrow(message);
  });

  it('reads the file from a directory, and fails when it is not there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-log-'));
    try {
      expect(() => loadChangeLog(dir)).toThrow();
      fs.writeFileSync(path.join(dir, 'audit-change-log.json'), JSON.stringify(changeLog));
      expect(loadChangeLog(dir)).toEqual(changeLog);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evaluateAuditPosture', () => {
  it('a correct catalog is clean', () => {
    expect(evaluateAuditPosture(cleanRows(), manifest)).toEqual([]);
  });

  it('names a change-record trigger that is disabled, missing, rebound or reshaped', () => {
    let rows = withTrigger(cleanRows(), 'public.users', 'users_audit_change_update', { enabled: 'D' });
    rows = withTrigger(rows, 'public.worker_skills', 'worker_skills_audit_change_insert', null);
    rows = withTrigger(rows, 'public.admin_cases', 'admin_cases_audit_change_delete', { args: ['id', 'id', '', 'status'] });
    rows = withTrigger(rows, 'public.employer_profiles', 'employer_profiles_audit_change_truncate', { type: 34 });
    rows = withTrigger(rows, 'public.worker_posts', 'worker_posts_audit_change_update', { new_table: null });
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'audit_change_trigger', object: 'public.admin_cases.admin_cases_audit_change_delete', detail: 'arguments differ from the expected ones' },
      { check: 'audit_change_trigger', object: 'public.employer_profiles.employer_profiles_audit_change_truncate', detail: 'fires on the wrong events or timing' },
      { check: 'audit_change_trigger', object: 'public.users.users_audit_change_update', detail: 'not enabled (tgenabled D)' },
      { check: 'audit_change_trigger', object: 'public.worker_posts.worker_posts_audit_change_update', detail: 'transition tables differ' },
      { check: 'audit_change_trigger', object: 'public.worker_skills.worker_skills_audit_change_insert', detail: 'missing' },
    ]);
  });

  it('names a change-record trigger on a table the file does not cover', () => {
    const rows = cleanRows();
    rows.triggers.push(trigger('public.jobs', 'jobs_audit_change_insert', 4, 'jale_audit.capture_change', { new_table: 'new_rows' }));
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'audit_change_trigger', object: 'public.jobs.jobs_audit_change_insert', detail: 'not in the change-log file' },
    ]);
  });

  it('names a guard trigger that is disabled, missing or calls another function, on every audit table and on the dashboard records', () => {
    let rows = withTrigger(cleanRows(), 'jale_audit.events', 'events_append_only', { enabled: 'R' });
    rows = withTrigger(rows, 'jale_audit.export_holds', 'export_holds_no_truncate', null);
    rows = withTrigger(rows, 'public.admin_audit_log', 'admin_audit_log_scrub', { function: 'public.noop' });
    rows = { ...rows, auditTables: [...rows.auditTables, 'jale_audit.unguarded'] };
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'audit_guard_trigger', object: 'jale_audit.events.events_append_only', detail: 'not enabled (tgenabled R)' },
      { check: 'audit_guard_trigger', object: 'jale_audit.export_holds.export_holds_no_truncate', detail: 'missing' },
      { check: 'audit_guard_trigger', object: 'jale_audit.unguarded.unguarded_append_only', detail: 'missing' },
      { check: 'audit_guard_trigger', object: 'jale_audit.unguarded.unguarded_no_truncate', detail: 'missing' },
      { check: 'audit_guard_trigger', object: 'public.admin_audit_log.admin_audit_log_scrub', detail: 'calls public.noop' },
    ]);
  });

  it('names an absent audit schema or dashboard table', () => {
    const rows = { ...cleanRows(), auditTables: [], legacyTable: false };
    rows.triggers = rows.triggers.filter((t) => t.function === 'jale_audit.capture_change');
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'audit_guard_trigger', object: 'jale_audit', detail: 'no audit tables in the catalog' },
      { check: 'audit_guard_trigger', object: 'public.admin_audit_log', detail: 'missing from the catalog' },
    ]);
  });

  it('names every privilege a role other than the owner holds on an audit relation or column', () => {
    const rows = {
      ...cleanRows(),
      grants: [
        { object: 'jale_audit.events', grantee: 'jale_api', privilege: 'SELECT' },
        { object: 'jale_audit.changes.actor_id', grantee: 'PUBLIC', privilege: 'SELECT' },
      ],
    };
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'audit_table_grants', object: 'jale_audit.changes.actor_id', detail: 'PUBLIC holds SELECT' },
      { check: 'audit_table_grants', object: 'jale_audit.events', detail: 'jale_api holds SELECT' },
    ]);
  });

  it('names a personal operator login that holds a table, column or sequence privilege, by name or by group', () => {
    const rows = {
      ...cleanRows(),
      logins: [
        { name: 'jale_api', member_of: [], relation_privileges: 40 },
        { name: 'jale_person_ana', member_of: ['jale_ops_readonly'], relation_privileges: 1 },
        { name: 'jale_person_ben', member_of: [], relation_privileges: 2 },
        { name: 'operator_cy', member_of: ['jale_ops_readonly'], relation_privileges: 3 },
        { name: 'jale_person_dee', member_of: ['jale_ops_readonly'], relation_privileges: 0 },
      ],
    };
    expect(evaluateAuditPosture(rows, manifest)).toEqual([
      { check: 'person_login_privileges', object: 'jale_person_ana', detail: 'holds 1 table, column or sequence privilege' },
      { check: 'person_login_privileges', object: 'jale_person_ben', detail: 'holds 2 table, column or sequence privileges' },
      { check: 'person_login_privileges', object: 'operator_cy', detail: 'holds 3 table, column or sequence privileges' },
    ]);
  });
});

describe('the extension', () => {
  const answering = (rows: Record<string, unknown[]>): PostureQueryable => ({
    query: async (text: string) => {
      if (text.includes("to_regclass('public.admin_audit_log')")) return { rows: rows.legacy ?? [] };
      if (text.includes('FROM pg_catalog.pg_trigger')) return { rows: rows.triggers ?? [] };
      if (text.includes('aclexplode(c.relacl)') && text.includes("nspname = 'jale_audit'")) return { rows: rows.grants ?? [] };
      if (text.includes('rolcanlogin')) return { rows: rows.logins ?? [] };
      if (text.includes("c.relkind IN ('r', 'p')")) return { rows: rows.tables ?? [] };
      throw new Error('unexpected read');
    },
  });

  it('is registered under one name, and reads what the evaluation needs', async () => {
    expect(auditPosture.name).toBe('audit');
    const clean = cleanRows();
    const ext = createAuditPosture(() => changeLog);
    const rows = await ext.read(answering({
      tables: clean.auditTables.map((name) => ({ name })),
      legacy: [{ present: true }],
      triggers: clean.triggers,
      grants: [],
      logins: clean.logins,
    }));
    expect(rows).toEqual(clean);
    expect(ext.evaluate(rows, manifest)).toEqual([]);
  });

  it('fails the read, so the run is incomplete, when the change-log file cannot be read', async () => {
    const ext = createAuditPosture(() => loadChangeLog(path.join(os.tmpdir(), 'no-such-dir')));
    await expect(ext.read(answering({}))).rejects.toThrow();
  });
});
