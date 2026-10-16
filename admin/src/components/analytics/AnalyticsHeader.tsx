import type { TabNavItem } from '@/components/ui/tab-nav';
import { TabNav } from '@/components/ui/tab-nav';
import { growthHref } from '@/lib/analytics-format';
import { employersHref } from '@/lib/employer-health';
import { funnelsHref } from '@/lib/funnel';
import { opsHref } from '@/lib/ops-health';
import type { FunnelWeeks } from '@/lib/types';
import { RangePicker } from './RangePicker';

export type AnalyticsTabKey = 'growth' | 'funnels' | 'employers' | 'ops';

// The four tabs; each link keeps the current range.
export function analyticsTabItems(active: AnalyticsTabKey, weeks: FunnelWeeks): TabNavItem[] {
  return [
    { label: 'Growth', href: growthHref(weeks, 'total'), active: active === 'growth' },
    { label: 'Funnels', href: funnelsHref(weeks, 'all'), active: active === 'funnels' },
    { label: 'Employers', href: employersHref(weeks), active: active === 'employers' },
    { label: 'Ops health', href: opsHref(weeks), active: active === 'ops' },
  ];
}

export function AnalyticsHeader({
  active,
  weeks,
  rangeHref,
  note,
}: {
  active: AnalyticsTabKey;
  weeks: FunnelWeeks;
  rangeHref: (weeks: FunnelWeeks) => string;
  note?: string;
}) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 text-3xl font-extrabold tracking-tight">Analytics</h1>
          <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
            Every item from the analytics list, grouped by the question it answers. Tags show the list number. Every chart
            labels both axes and every value.
          </p>
        </div>
        <RangePicker current={weeks} hrefFor={rangeHref} />
      </div>
      <TabNav label="Analytics sections" items={analyticsTabItems(active, weeks)} />
      {note ? <p className="m-0 text-xs text-[var(--jale-ink-2)]">{note}</p> : null}
    </header>
  );
}
