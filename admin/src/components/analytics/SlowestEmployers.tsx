import { formatCount } from '@/lib/analytics-format';
import { employerLabel, formatDuration } from '@/lib/employer-health';
import type { SlowestEmployer } from '@/lib/types';

export function SlowestEmployers({ rows }: { rows: SlowestEmployer[] }) {
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Slowest employers</h2>
          <p>Employers with 3+ applications in these weeks · most unanswered first, then slowest median</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No employer has 3+ applications in these weeks.</p>
      ) : (
        <div className="table-scroll" role="region" aria-label="Slowest employers table" tabIndex={0}>
          <table className="data-table cohort-table">
            <thead>
              <tr>
                <th>Employer</th>
                <th className="num">Applications</th>
                <th className="num">Unanswered 7d</th>
                <th className="num">Median first response</th>
                <th className="num">Active jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employerId}>
                  <td className="wrap">{employerLabel(row.displayName, row.employerId)}</td>
                  <td className="num">{formatCount(row.applications)}</td>
                  <td className="num">{formatCount(row.unanswered7d)}</td>
                  <td className="num">{formatDuration(row.firstResponseP50Hours)}</td>
                  <td className="num">{formatCount(row.activeJobs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
