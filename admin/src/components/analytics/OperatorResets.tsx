import { formatCount } from '@/lib/analytics-format';
import { bulkRunsNote, resetTableRows } from '@/lib/restarts';
import type { OperatorReset } from '@/lib/types';

export function OperatorResets({ rows, now }: { rows: OperatorReset[]; now: Date }) {
  const tableRows = resetTableRows(rows, now);
  const bulkNote = bulkRunsNote(rows, now);
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Operator resets</h2>
          <p>Newest first · workers an operator sent back to the start of onboarding, by week and reason</p>
          <p>Operator resets have no door, so this table shows every door.</p>
        </div>
      </div>
      {tableRows.length === 0 ? (
        <p className="muted">
          {bulkNote === null ? 'No operator resets in these weeks.' : 'No other operator resets in these weeks.'}
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Operator resets table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Reason</th>
                <th className="num">Workers</th>
                <th className="num">Resets</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={`${row.weekStart}:${row.reason}`}>
                  <td>
                    {row.label}
                    {row.current ? <span className="cohort-settling" title="This week is still in progress">so far</span> : null}
                  </td>
                  <td className="wrap restarts-reason">{row.reason}</td>
                  <td className="num">{formatCount(row.workers)}</td>
                  <td className="num">{formatCount(row.resets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {bulkNote === null ? null : <p className="muted restarts-note">{bulkNote}</p>}
    </article>
  );
}
