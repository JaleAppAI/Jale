import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { StatusBadge } from '@/components/ui/status-badge';
import type { HealthItem } from '@/lib/server/admin-analytics';
import { SECTION_HEADING } from './home-format';

/** K3.4: six items, each state in words and colour (never colour alone). */
export function SystemHealth({ result }: { result: { items: HealthItem[]; windowLabel: string } | null }) {
  return (
    <section aria-labelledby="home-health" className="flex flex-col gap-3.5">
      <h2 id="home-health" className={SECTION_HEADING}>{result ? `System health · ${result.windowLabel}` : 'System health'}</h2>
      {result === null ? (
        <DashboardPanel>
          <ErrorState kind="server" compact title="Health unavailable" body="The health checks could not be loaded. Refresh the page to try again." />
        </DashboardPanel>
      ) : result.items.length === 0 ? (
        <DashboardPanel>
          <EmptyState icon="alert" variant="filtered" title="No health checks to show" />
        </DashboardPanel>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))] gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)]">
          {result.items.map((item) => (
            <li key={item.key} className="flex min-w-0 flex-col gap-1.5 bg-[var(--jale-card)] shadow-[0_0_0_1px_var(--jale-divider)] px-[18px] py-4">
              <StatusBadge state={item.state} />
              <span className="text-sm font-semibold text-[var(--jale-ink)]">{item.label}</span>
              <span className="text-xs text-[var(--jale-ink-2)]">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
