import { withUnit } from '@/lib/chart-geometry';
import type { ChartSeries, ChartTable } from './types';

// The role="img" label: the chart title and its latest bucket, per series.
export function chartSummary(
  title: string,
  labels: string[],
  series: ChartSeries[],
  format: (v: number) => string,
  unit = '',
  partialLast = false,
): string {
  if (labels.length === 0 || series.length === 0) return `${title}: no data`;
  const last = labels.length - 1;
  const when = `${labels[last]}${partialLast ? ' (so far)' : ''}`;
  const parts = series.map((s) => {
    const v = s.values[last] ?? null;
    return `${s.label} ${v === null ? 'no value' : withUnit(format(v), unit)}`;
  });
  return `${title}, latest ${when}: ${parts.join('; ')}`;
}

// The table twin of a weekly chart: one row per bucket, one column per series.
// A gap prints as a dash; the partial bucket is marked "(so far)".
export function seriesTable(
  caption: string,
  labels: string[],
  series: ChartSeries[],
  options: { format: (v: number) => string; unit?: string; partialLast?: boolean; firstColumn?: string },
): ChartTable {
  const { format, unit = '', partialLast = false, firstColumn = 'Week' } = options;
  return {
    caption,
    columns: [firstColumn, ...series.map((s) => s.label)],
    rows: labels.map((label, i) => [
      partialLast && i === labels.length - 1 ? `${label} (so far)` : label,
      ...series.map((s) => {
        const v = s.values[i] ?? null;
        return v === null ? '—' : withUnit(format(v), unit);
      }),
    ]),
  };
}
