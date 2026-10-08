import { formatCount } from '@/lib/analytics-format';
import { answeredLabel, formatDays, formatDurationPair } from '@/lib/employer-health';
import type { EmployerWeekTableRow } from '@/lib/types';

const approxTitle = (approximate: number): string =>
  `${formatCount(approximate)} of this week's hires happened before hire times were recorded`;

export function EmployerWeeklyTable({ rows }: { rows: EmployerWeekTableRow[] }) {
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Week by week</h2>
          <p>Newest first · applications and worker message runs by the week they started, hires by the week of the hire</p>
        </div>
      </div>
      <div className="table-scroll" role="region" aria-label="Week by week table" tabIndex={0}>
        <table className="data-table cohort-table">
          <thead>
            <tr>
              <th>Week</th>
              <th className="num">Applications</th>
              <th className="num">Answered</th>
              <th className="num">Unanswered 7d</th>
              <th className="num">First response (p50 / p75)</th>
              <th className="num">Worker messages</th>
              <th className="num">Reply (p50 / p75)</th>
              <th className="num">Hires</th>
              <th className="num">Time to hire</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.weekStart}>
                <td>
                  {row.label}
                  {row.settling ? (
                    <span className="cohort-settling" title="Under 14 days old: unanswered counts are not final yet">settling</span>
                  ) : null}
                </td>
                <td className="num">{formatCount(row.applications)}</td>
                <td className="num">{answeredLabel(row)}</td>
                <td className="num">{formatCount(row.unanswered7d)}</td>
                <td className="num">{formatDurationPair(row.firstResponseP50Hours, row.firstResponseP75Hours)}</td>
                <td className="num">{formatCount(row.workerTurns)}</td>
                <td className="num">{formatDurationPair(row.replyP50Hours, row.replyP75Hours)}</td>
                <td className="num">{formatCount(row.hires)}</td>
                <td className="num">
                  {formatDays(row.timeToHireP50Days)}
                  {row.approximate ? (
                    <span className="employer-approx" title={approxTitle(row.hiresApproximate)}>approx.</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}
