/**
 * audit-change-log.ts -- the change-log file (infra/db/access/
 * audit-change-log.json, read through posture-audit.ts) and the
 * change-record triggers it implies.
 *
 * The migration that binds the triggers carries exactly renderTriggers()'s
 * output between its GENERATED markers (migrations.test.ts checks it), and
 * the change-log suite checks the file against the catalog and the live
 * triggers. To print the statements after changing the file (from infra/):
 *
 *   npx tsx -e "import { renderTriggers } from './test/unit/db/helpers/audit-change-log'; console.log(renderTriggers())"
 */
import * as path from 'path';
import {
  CHANGE_LOG_FILE, CHANGE_TRIGGER_EVENTS, changeTriggerArgs, changeTriggerName, loadChangeLog,
  type ChangeLog, type ChangeLogTable,
} from '../../../../db/access/posture-audit';

export type { ChangeLog, ChangeLogTable };
export { loadChangeLog };

export const CHANGE_LOG_PATH = path.join(__dirname, '..', '..', '..', '..', 'db', 'access', CHANGE_LOG_FILE);

export const triggerArgs = changeTriggerArgs;
export const triggerName = changeTriggerName;

/** The REFERENCING clause each event's trigger declares. */
const referencing = (oldTable: string | null, newTable: string | null): string | null => {
  const parts = [oldTable ? `OLD TABLE AS ${oldTable}` : null, newTable ? `NEW TABLE AS ${newTable}` : null].filter(Boolean);
  return parts.length ? `REFERENCING ${parts.join(' ')}` : null;
};

export const TRIGGER_EVENTS = CHANGE_TRIGGER_EVENTS.map((e) => ({
  event: e.event, suffix: e.suffix, referencing: referencing(e.oldTable, e.newTable),
}));

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The CREATE TRIGGER statements for every covered table, in table-name order. */
export function renderTriggers(log: ChangeLog = loadChangeLog()): string {
  const out: string[] = [];
  for (const name of Object.keys(log.tables).sort()) {
    const args = triggerArgs(log.tables[name]).map(literal).join(', ');
    for (const t of TRIGGER_EVENTS) {
      out.push(`CREATE TRIGGER ${triggerName(name, t.suffix)} AFTER ${t.event} ON ${name}`);
      if (t.referencing) out.push(`  ${t.referencing}`);
      out.push(`  FOR EACH STATEMENT EXECUTE FUNCTION jale_audit.capture_change(${args});`);
    }
  }
  return out.join('\n');
}
