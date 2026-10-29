import { Badge, type BadgeTone } from '@/components/ui/badge';
import { periodEndLabel } from '@/lib/analytics-format';
import type { PayingEmployer } from '@/lib/types';
import { AnalyticsPanel } from './AnalyticsPanel';
import { CompanyLink } from './CompanyLink';
import { SeatMeter } from './SeatMeter';

const STATUS_TONE: Record<string, BadgeTone> = { active: 'success', trialing: 'info', past_due: 'warning' };

export function PayingEmployersList({ rows }: { rows: PayingEmployer[] }) {
  return (
    <AnalyticsPanel
      title="Paying companies"
      subtitle={`${rows.length} subscriptions · active, trialing, or past due`}
      howCounted="Seat limit follows each row's plan."
    >
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-[var(--jale-ink-2)]">No paying companies yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li
              key={`${row.employerId}-${row.planCode}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--jale-divider)] py-2 text-sm first:border-t-0"
            >
              <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">
                <CompanyLink name={row.displayName} ownerId={row.employerId} organizationId={row.organizationId} />
              </span>
              <span className="text-xs text-[var(--jale-ink-2)]"><SeatMeter seats={row} /></span>
              <span className="text-xs text-[var(--jale-ink-2)]">{row.planCode}</span>
              <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status.replace('_', ' ')}</Badge>
              <span className={row.cancelAtPeriodEnd ? 'text-xs font-semibold text-[var(--jale-warning-text)]' : 'text-xs'}>
                {periodEndLabel(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </AnalyticsPanel>
  );
}
