import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { employerLabel, formatDuration } from '@/lib/employer-health';
import type { SlowestEmployer } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { TABLE, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

export function SlowestEmployers({ rows }: { rows: SlowestEmployer[] }) {
  return (
    <AnalyticsPanel title="Slowest employers" subtitle="Employers with 3+ applications in these weeks · most unanswered first, then slowest median">
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No employer has 3+ applications in these weeks.</p>
      ) : (
        <TableScroll label="Slowest employers table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Employer</th>
                <th className={TH_NUM}>Applications</th>
                <th className={TH_NUM}>Unanswered 7d</th>
                <th className={TH_NUM}>Median first response</th>
                <th className={TH_NUM}>Active jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employerId}>
                  <td className={TD_WRAP}>{employerLabel(row.displayName, row.employerId)}</td>
                  <td className={TD_NUM}>{formatCount(row.applications)}</td>
                  <td className={TD_NUM}>{formatCount(row.unanswered7d)}</td>
                  <td className={TD_NUM}>{formatDuration(row.firstResponseP50Hours)}</td>
                  <td className={TD_NUM}>{formatCount(row.activeJobs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </AnalyticsPanel>
  );
}
