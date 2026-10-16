import { ChartFrame } from '@/components/analytics/charts/ChartFrame';
import { LineChart } from '@/components/analytics/charts/LineChart';
import { seriesTable } from '@/components/analytics/charts/text';
import type { ChartSeries } from '@/components/analytics/charts/types';
import { bucketLabel, formatCount } from '@/lib/analytics-format';
import type { HomeMetrics } from '@/lib/server/admin-analytics';

/**
 * Home's signups chart on FE-4's shared components (00-FE-INTERFACES §5):
 * ChartFrame holds the title and the <details> table twin, LineChart draws
 * the series with titled axes, labelled points and the hollow partial week.
 */
export function HomeSignupsChart({ weeks }: { weeks: HomeMetrics['signupsWeekly'] }) {
  const labels = weeks.map((week) => bucketLabel(week.weekStart, '30d'));
  const series: ChartSeries[] = [
    { key: 'cumulative', label: 'Signups (cumulative)', color: 'chart-1', values: weeks.map((week) => week.cumulative) },
  ];
  const partialLast = weeks.length > 0 && weeks[weeks.length - 1].partial;
  return (
    <ChartFrame
      title="Signups, cumulative"
      subtitle="Workers and employers"
      table={seriesTable('Signups, cumulative, by week', labels, series, { format: formatCount, partialLast })}
    >
      {weeks.length > 0 ? (
        <LineChart title="Signups, cumulative" labels={labels} series={series} xTitle="Week" yTitle="Signups" partialLast={partialLast} />
      ) : (
        <p className="py-10 text-center text-sm text-[var(--jale-ink-2)]">No data yet</p>
      )}
    </ChartFrame>
  );
}
