import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { formatDuration } from '@/lib/employer-health';
import type { SlowestEmployer } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { CompanyLink } from './CompanyLink';
import { TABLE, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

export function SlowestEmployers({ rows }: { rows: SlowestEmployer[] }) {
  return (
    <AnalyticsPanel
      title="Slowest companies"
      subtitle="Companies with 3+ applications in these weeks · most unanswered first, then slowest median"
      howCounted="Test companies are those whose owner is a test account."
    >
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No company has 3+ applications in these weeks.</p>
      ) : (
        <TableScroll label="Slowest companies table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Company</th>
                <th className={TH_NUM}>Applications</th>
                <th className={TH_NUM}>Unanswered 7d</th>
                <th className={TH_NUM}>Median first response</th>
                <th className={TH_NUM}>Active jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employerId}>
                  <td className={TD_WRAP}>
                    <CompanyLink name={row.displayName} ownerId={row.employerId} organizationId={row.organizationId} />
                  </td>
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
