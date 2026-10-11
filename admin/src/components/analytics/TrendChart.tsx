import type { ReactNode } from 'react';
import {
  areaPath,
  endPoint,
  isolatedPoints,
  labelIndices,
  linePath,
  niceMax,
  spreadLabels,
  tickIntervals,
  tickValues,
  xPositions,
} from '@/lib/chart-geometry';
import { formatCount } from '@/lib/analytics-format';

export type TrendSeries = {
  key: string;
  label: string;
  color: string;
  /** One value per bucket; `null` = no value, drawn as a gap (never as 0). */
  values: (number | null)[];
  /** Draw a soft area wash under this series (use on at most one series; skipped if it has gaps). */
  area?: boolean;
  /** Text beside the end-dot, e.g. "6 workers". Omit to label with the bare value. No dot or label when the last value is null. */
  endLabel?: string;
};

export type TrendChartProps = {
  title: string;
  subtitle?: string;
  /** One label per bucket, used for the x-axis and the table twin. */
  labels: string[];
  series: TrendSeries[];
  width?: number;
  height?: number;
  tableCaption: string;
  /** The last bucket is still in progress (today / this week): hollow end-dots, "(so far)" in the table. */
  partialLast?: boolean;
  /** Controls rendered first in the chart's tool row, e.g. a view toggle. */
  tools?: ReactNode;
  /** viewBox units reserved on the right for end-dot labels. Default 78; widen for longer labels. */
  right?: number;
};

const LEFT = 40;
const TOP = 20;
const BOTTOM = 30;

export function TrendChart({
  title,
  subtitle,
  labels,
  series,
  width = 1188,
  height = 290,
  tableCaption,
  partialLast = false,
  tools,
  right = 78,
}: TrendChartProps) {
  const plotW = width - LEFT - right;
  const plotH = height - TOP - BOTTOM;
  const max = niceMax(series.flatMap((s) => s.values));
  const ticks = tickValues(max, tickIntervals(max));
  const xs = xPositions(labels.length, plotW);
  const dateIdx = labelIndices(labels.length);
  const tickY = (v: number) => TOP + plotH - (v / max) * plotH;
  // Lines that finish close together would print their end labels on top of
  // each other; 14 viewBox units is one 12px label plus a little air. A line
  // whose last value is null has no end dot or label, so it takes no room.
  const lastValue = (s: TrendSeries) => s.values[s.values.length - 1] ?? null;
  const ended = series.filter((s) => lastValue(s) !== null);
  const spread = spreadLabels(ended.map((s) => endPoint(s.values, plotW, plotH, max).y + 4), 14, plotH + 4);
  const labelY = new Map(ended.map((s, i) => [s.key, spread[i]]));

  return (
    <article className="card chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="chart-tools">
          {tools}
          {series.length > 1 ? (
            <div className="chart-legend" aria-label="Legend">
              {series.map((s) => (
                <span key={s.key}>
                  <i className="legend-key" style={{ background: s.color }} aria-hidden="true" />
                  {s.label}
                </span>
              ))}
            </div>
          ) : null}
          <details className="chart-table">
            <summary aria-label={`${title} as a table`}>Table</summary>
            <div className="table-scroll" role="region" aria-label={`${title} table`} tabIndex={0}>
              <table className="data-table">
                <caption className="muted" style={{ textAlign: 'left', padding: '4px 10px' }}>{tableCaption}</caption>
                <thead>
                  <tr>
                    <th>Period</th>
                    {series.map((s) => <th key={s.key} className="num">{s.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {labels.map((label, i) => (
                    <tr key={label}>
                      <td>{partialLast && i === labels.length - 1 ? `${label} (so far)` : label}</td>
                      {series.map((s) => {
                        const value = s.values[i];
                        return <td key={s.key} className="num">{value === null ? '—' : formatCount(value ?? 0)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </div>

      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        {ticks.map((t, i) => (
          <g key={t}>
            <line
              x1={LEFT}
              x2={LEFT + plotW}
              y1={tickY(t)}
              y2={tickY(t)}
              stroke={i === 0 ? '#c3c2b7' : '#e6e9ef'}
              strokeWidth={1}
            />
            <text className="tick" x={LEFT - 10} y={tickY(t) + 4} textAnchor="end">{formatCount(t)}</text>
          </g>
        ))}
        <g transform={`translate(${LEFT}, ${TOP})`}>
          {series.map((s) =>
            s.area && s.values.every((v): v is number => v !== null) ? (
              <path key={`${s.key}-area`} d={areaPath(s.values, plotW, plotH, max)} fill={s.color} fillOpacity={0.08} />
            ) : null,
          )}
          {series.map((s) => (
            <path
              key={s.key}
              d={linePath(s.values, plotW, plotH, max)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {series.map((s) =>
            isolatedPoints(s.values, plotW, plotH, max).map((p) => (
              <circle key={`${s.key}-dot-${p.x}`} cx={p.x} cy={p.y} r={3} fill={s.color} />
            )),
          )}
          {ended.map((s) => {
            const end = endPoint(s.values, plotW, plotH, max);
            const last = lastValue(s) ?? 0;
            return (
              <g key={`${s.key}-end`}>
                <circle
                  cx={end.x}
                  cy={end.y}
                  r={4}
                  fill={partialLast ? '#ffffff' : s.color}
                  stroke={partialLast ? s.color : '#ffffff'}
                  strokeWidth={2}
                />
                <text className="end-label" x={end.x + 10} y={labelY.get(s.key)}>{s.endLabel ?? formatCount(last)}</text>
              </g>
            );
          })}
        </g>
        {dateIdx.map((i) => {
          const x = LEFT + xs[i];
          const anchor = i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle';
          return (
            <text key={labels[i]} className="axis-date" x={x} y={height - 6} textAnchor={anchor}>{labels[i]}</text>
          );
        })}
      </svg>
    </article>
  );
}
