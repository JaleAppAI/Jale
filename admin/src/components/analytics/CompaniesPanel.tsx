import { TableScroll } from '@/components/ui/table-scroll';
import { formatCount } from '@/lib/analytics-format';
import { planLabel } from '@/lib/employer-health';
import type { CompanySummary } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { CompanyLink } from './CompanyLink';
import { SeatMeter } from './SeatMeter';
import { TABLE, TD_NUM, TD_WRAP, TH, TH_NUM } from './table-styles';

// One row per company, most seats held first; the name opens the company page.
// The list is capped at `limit`: past it, the rest are reached from the paying
// and slowest lists.
export function CompaniesPanel({ rows, limit }: { rows: CompanySummary[]; limit: number }) {
  const full = rows.length === limit;
  const subtitle = rows.length === 0
    ? 'Test accounts left out'
    : `Top ${rows.length} by seats held; test accounts left out${full ? ' · Open any company from the paying or slowest lists' : ''}`;
  return (
    <AnalyticsPanel title="Companies" subtitle={subtitle}>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No companies yet.</p>
      ) : (
        <TableScroll label="Companies table">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>Company</th>
                <th className={TH}>Plan</th>
                <th className={TH_NUM}>Members</th>
                <th className={TH}>Seats</th>
                <th className={TH_NUM}>Active jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.organizationId}>
                  <td className={TD_WRAP}>
                    <CompanyLink name={row.displayName} ownerId={row.ownerId} organizationId={row.organizationId} />
                  </td>
                  <td className={TD_WRAP}>{planLabel(row.planCode)}</td>
                  <td className={TD_NUM}>{formatCount(row.membersActive)}</td>
                  <td className={TD_WRAP}><SeatMeter seats={row} /></td>
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
