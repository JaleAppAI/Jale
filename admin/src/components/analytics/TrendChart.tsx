import {
  areaPath,
  endPoint,
  labelIndices,
  linePath,
  niceMax,
  tickValues,
  xPositions,
} from '@/lib/chart-geometry';
import { formatCount } from '@/lib/analytics-format';

export type TrendSeries = {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** Draw a soft area wash under this series (use on at most one series). */
  area?: boolean;
  /** Text beside the end-dot, e.g. "6 workers". Omit to label with the bare value. */
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
};

const LEFT = 40;
const RIGHT = 78;
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
}: TrendChartProps) {
  const plotW = width - LEFT - RIGHT;
  const plotH = height - TOP - BOTTOM;
  const max = niceMax(series.flatMap((s) => s.values));
  const ticks = tickValues(max);
  const xs = xPositions(labels.length, plotW);
  const dateIdx = labelIndices(labels.length);
  const tickY = (v: number) => TOP + plotH - (v / max) * plotH;

  return (
    <article className="card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="chart-tools">
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
                    <td>{label}</td>
                    {series.map((s) => <td key={s.key} className="num">{formatCount(s.values[i] ?? 0)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
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
          {series.filter((s) => s.area).map((s) => (
            <path key={`${s.key}-area`} d={areaPath(s.values, plotW, plotH, max)} fill={s.color} fillOpacity={0.08} />
          ))}
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
          {series.map((s) => {
            const end = endPoint(s.values, plotW, plotH, max);
            const last = s.values[s.values.length - 1] ?? 0;
            return (
              <g key={`${s.key}-end`}>
                <circle cx={end.x} cy={end.y} r={4} fill={s.color} stroke="#ffffff" strokeWidth={2} />
                <text className="end-label" x={end.x + 10} y={end.y + 4}>{s.endLabel ?? formatCount(last)}</text>
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
