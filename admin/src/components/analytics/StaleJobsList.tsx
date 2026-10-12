import { formatCount } from '@/lib/analytics-format';
import { STALE_JOBS_SHOWN, employerLabel, firstWithRest, formatDay, isIdleSincePosting } from '@/lib/employer-health';
import type { StaleJob } from '@/lib/types';

export function StaleJobsList({ rows, days }: { rows: StaleJob[]; days: number }) {
  const { shown, more } = firstWithRest(rows, STALE_JOBS_SHOWN);
  return (
    <article className="card cohort-card">
      <div className="chart-head" style={{ marginBottom: 8 }}>
        <div>
          <h2>Stale jobs</h2>
          <p>Active jobs with no employer action for {days}+ days · most idle first</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No active job has gone {days}+ days without employer activity.</p>
      ) : (
        <>
          <div className="table-scroll" role="region" aria-label="Stale jobs table" tabIndex={0}>
            <table className="data-table cohort-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Employer</th>
                  <th>Idle</th>
                  <th className="num">Waiting applicants</th>
                  <th>Last application</th>
                  <th>Posted</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((job) => (
                  <tr key={job.jobId}>
                    <td className="wrap">{job.title}</td>
                    <td className="wrap">{employerLabel(job.displayName, job.employerId)}</td>
                    <td>
                      {formatCount(job.daysIdle)} d
                      {isIdleSincePosting(job) ? <span className="employer-note">since posting</span> : null}
                    </td>
                    <td className="num">{formatCount(job.waitingApplicants)}</td>
                    <td>{formatDay(job.lastApplicationAt)}</td>
                    <td>{formatDay(job.postedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more > 0 ? <p className="muted employer-more">and {formatCount(more)} more</p> : null}
        </>
      )}
    </article>
  );
}
