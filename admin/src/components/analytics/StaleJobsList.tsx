import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { STALE_JOBS_SHOWN, employerLabel, firstWithRest, formatDay, isIdleSincePosting } from '@/lib/employer-health';
import type { StaleJob } from '@/lib/types';
import { TABLE, TD, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

// The #4 list, most idle first: the first STALE_JOBS_SHOWN, then "and N more"
// (the loader records exactly the rows shown).
export function StaleJobsList({ rows, days }: { rows: StaleJob[]; days: number }) {
  const { shown, more } = firstWithRest(rows, STALE_JOBS_SHOWN);
  if (rows.length === 0) {
    return <p className="m-0 text-sm text-[var(--jale-ink-2)]">No active job has gone {days}+ days without employer activity.</p>;
  }
  return (
    <>
      <TableScroll label="Stale jobs table">
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH}>Job</th>
              <th className={TH}>Employer</th>
              <th className={TH}>Idle</th>
              <th className={TH_NUM}>Waiting applicants</th>
              <th className={TH}>Last application</th>
              <th className={TH}>Posted</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((job) => (
              <tr key={job.jobId}>
                <td className={TD_WRAP}>{job.title}</td>
                <td className={TD_WRAP}>{employerLabel(job.displayName, job.employerId)}</td>
                <td className={TD}>
                  {formatCount(job.daysIdle)} d
                  {isIdleSincePosting(job) ? <span className="ml-2 text-xs text-[var(--jale-ink-2)]">since posting</span> : null}
                </td>
                <td className={TD_NUM}>{formatCount(job.waitingApplicants)}</td>
                <td className={TD}>{formatDay(job.lastApplicationAt)}</td>
                <td className={TD}>{formatDay(job.postedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {more > 0 ? <p className="m-0 text-sm text-[var(--jale-ink-2)]">and {formatCount(more)} more</p> : null}
    </>
  );
}
