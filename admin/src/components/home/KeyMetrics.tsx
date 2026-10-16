import Link from 'next/link';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { StatTile } from '@/components/ui/stat-tile';
import type { HomeMetrics } from '@/lib/server/admin-analytics';
import { HomeSignupsChart } from './HomeSignupsChart';
import { keyMetricTiles, SECTION_HEADING, type KeyMetricTile } from './home-format';

const HINT_TONES: Record<KeyMetricTile['tone'], string> = {
  positive: 'font-semibold text-[var(--jale-success-text)]',
  neutral: 'text-[var(--jale-ink-2)]',
  warning: 'font-semibold text-[var(--jale-warning-text)]',
};

export function KeyMetrics({ metrics }: { metrics: HomeMetrics | null }) {
  return (
    <section aria-labelledby="home-metrics" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="home-metrics" className={SECTION_HEADING}>Key metrics</h2>
        <Link
          href="/analytics"
          prefetch={false}
          className="rounded text-[13px] font-semibold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          Open analytics <span aria-hidden="true">→</span>
        </Link>
      </div>
      {metrics ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-4">
            {keyMetricTiles(metrics).map((tile) => (
              <StatTile key={tile.label} label={tile.label} value={tile.value} hint={<span className={HINT_TONES[tile.tone]}>{tile.hint}</span>} />
            ))}
          </div>
          <HomeSignupsChart weeks={metrics.signupsWeekly} />
        </>
      ) : (
        <DashboardPanel>
          <ErrorState kind="server" compact title="Metrics unavailable" body="The key metrics could not be loaded. Refresh the page to try again." />
        </DashboardPanel>
      )}
    </section>
  );
}
