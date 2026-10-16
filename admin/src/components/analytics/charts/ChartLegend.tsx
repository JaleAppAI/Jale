import { CHART_LABEL, CHART_SURFACE, CHART_VAR, HOLLOW_POINT_NOTE } from './tokens';
import type { ChartSeries, LegendItem } from './types';

// Two or more series get a key per series; a partial last bucket adds the
// hollow-point note. One series needs no key: the panel title names it.
export function lineLegend(series: ChartSeries[], partialLast: boolean, note: string = HOLLOW_POINT_NOTE): LegendItem[] {
  const items: LegendItem[] = series.length >= 2 ? series.map((s) => ({ label: s.label, color: s.color })) : [];
  if (partialLast) items.push({ label: note, color: series[0]?.color ?? 'chart-1', hollow: true });
  return items;
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-chart-legend="" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs" style={{ color: CHART_LABEL }}>
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            data-swatch={item.hollow ? 'hollow' : 'filled'}
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={
              item.hollow
                ? { boxSizing: 'border-box', border: `2px solid ${CHART_VAR[item.color]}`, background: CHART_SURFACE }
                : { background: CHART_VAR[item.color] }
            }
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
