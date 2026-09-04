import { columnPaths, labelIndices, niceMax, tickValues } from '@/lib/chart-geometry';
import { formatCount } from '@/lib/analytics-format';

export type ColumnChartProps = {
  title: string;
  subtitle?: string;
  labels: string[];
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  tableCaption: string;
  /** Column header for the value in the table twin, e.g. "Jobs posted". */
  valueHeader: string;
};

const LEFT = 40;
const RIGHT = 8;
const TOP = 20;
const BOTTOM = 30;

export function ColumnChart({
  title,
  subtitle,
  labels,
  values,
  color = '#0179ff',
  width = 570,
  height = 200,
  tableCaption,
  valueHeader,
}: ColumnChartProps) {
  const plotW = width - LEFT - RIGHT;
  const plotH = height - TOP - BOTTOM;
  const max = niceMax(values);
  const ticks = tickValues(max, 2);
  const dateIdx = labelIndices(labels.length, 3);
  const tickY = (v: number) => TOP + plotH - (v / max) * plotH;

  return (
    <article className="card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <details className="chart-table">
          <summary aria-label={`${title} as a table`}>Table</summary>
          <table className="data-table">
            <caption className="muted" style={{ textAlign: 'left', padding: '4px 10px' }}>{tableCaption}</caption>
            <thead>
              <tr><th>Period</th><th className="num">{valueHeader}</th></tr>
            </thead>
            <tbody>
              {labels.map((label, i) => (
                <tr key={label}><td>{label}</td><td className="num">{formatCount(values[i] ?? 0)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>

      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} chart`}>
        {ticks.map((t, i) => (
          <g key={t}>
            <line x1={LEFT} x2={LEFT + plotW} y1={tickY(t)} y2={tickY(t)} stroke={i === 0 ? '#c3c2b7' : '#e6e9ef'} strokeWidth={1} />
            <text className="tick" x={LEFT - 10} y={tickY(t) + 4} textAnchor="end">{formatCount(t)}</text>
          </g>
        ))}
        <g transform={`translate(${LEFT}, ${TOP})`}>
          {columnPaths(values, plotW, plotH, max).map((d, i) => <path key={i} d={d} fill={color} />)}
        </g>
        {dateIdx.map((i) => {
          // Columns are centered in their slot, so date labels sit on slot centers, not the line x-positions.
          const slot = plotW / labels.length;
          const x = LEFT + i * slot + slot / 2;
          const anchor = i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle';
          return <text key={labels[i]} className="axis-date" x={x} y={height - 6} textAnchor={anchor}>{labels[i]}</text>;
        })}
      </svg>
    </article>
  );
}
