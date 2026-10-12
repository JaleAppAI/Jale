import { formatCount, percentOf } from '@/lib/analytics-format';
import { shareShade } from '@/lib/funnel';
import type { CohortCounts } from '@/lib/types';

export type CohortTableRow = CohortCounts & { label: string; settling: boolean };

const SHARE_COLUMNS: { key: keyof CohortCounts; header: string; whatsappOnly?: boolean }[] = [
  { key: 'codeRequested', header: 'Code', whatsappOnly: true },
  { key: 'verified', header: 'Verified' },
  { key: 'acceptedTerms', header: 'Terms' },
  { key: 'finishedProfile', header: 'Profile' },
  { key: 'ready', header: 'Ready' },
];

export function CohortTable({ rows, showCode }: { rows: CohortTableRow[]; showCode: boolean }) {
  const shares = SHARE_COLUMNS.filter((column) => showCode || !column.whatsappOnly);
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Weekly cohorts</h2>
          <p>Grouped by the week of first contact, newest first</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table cohort-table">
          <thead>
            <tr>
              <th>Week</th>
              <th className="num">Started</th>
              {shares.map((column) => (
                <th key={column.key} className="num">{column.header}</th>
              ))}
              <th className="num">In progress</th>
              <th className="num">Abandoned</th>
              <th className="num">Declined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cohortWeek}>
                <td>
                  {row.label}
                  {row.settling ? (
                    <span className="cohort-settling" title="Workers in this week can still move for 7 days after it ends">settling</span>
                  ) : null}
                </td>
                <td className="num">{formatCount(row.started)}</td>
                {shares.map((column) => {
                  const count = row[column.key] as number;
                  return (
                    <td key={column.key} className="num" style={{ background: shareShade(count, row.started) }}>
                      {percentOf(count, row.started) ?? '—'}
                    </td>
                  );
                })}
                <td className="num">{formatCount(row.inProgress)}</td>
                <td className="num">{formatCount(row.abandoned)}</td>
                <td className="num">{formatCount(row.declined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}
