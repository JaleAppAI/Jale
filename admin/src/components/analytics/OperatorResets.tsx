import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { bulkRunsNote, resetTableRows } from '@/lib/restarts';
import type { OperatorReset } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

export function OperatorResets({ rows, now }: { rows: OperatorReset[]; now: Date }) {
  const tableRows = resetTableRows(rows, now);
  const bulkNote = bulkRunsNote(rows, now);
  return (
    <AnalyticsPanel
      title="Operator resets"
      subtitle="Newest first · workers an operator sent back to the start of onboarding, by week and reason. Operator resets have no door, so this table shows every door."
      howCounted="Operator resets count every reset an operator ran; a reason used for 10 or more workers within an hour is a bulk run, left out of the counts and listed under the table. Reasons are typed by operators; long numbers, emails and IDs are hidden."
    >
      {tableRows.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">
          {bulkNote === null ? 'No operator resets in these weeks.' : 'No other operator resets in these weeks.'}
        </p>
      ) : (
        <TableScroll label="Operator resets table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Week</th>
                <th className={TH}>Reason</th>
                <th className={TH_NUM}>Workers</th>
                <th className={TH_NUM}>Resets</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={`${row.weekStart}:${row.reason}`}>
                  <td className={TD}>
                    {row.label}
                    {row.current ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className={TD_WRAP}>{row.reason}</td>
                  <td className={TD_NUM}>{formatCount(row.workers)}</td>
                  <td className={TD_NUM}>{formatCount(row.resets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {bulkNote === null ? null : <p className="m-0 text-sm text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">{bulkNote}</p>}
    </AnalyticsPanel>
  );
}
