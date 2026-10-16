import { formatCount } from '@/lib/analytics-format';
import {
  LABEL_BOX_HEIGHT,
  MARKER_HALF,
  axisRange,
  estimateTextWidth,
  formatTick,
  hollowFlags,
  minPlotWidth,
  placeValueLabels,
  pointFractions,
  preferredSides,
  scaledLinePath,
  withUnit,
  xTickIndices,
  yPx,
  type Box,
  type LabelPoint,
} from '@/lib/chart-geometry';
import {
  ChartScroll,
  GridLines,
  Marker,
  PlotSvg,
  ValueLabels,
  XTicks,
  YTicks,
} from './axes';
import { ChartLegend, lineLegend } from './ChartLegend';
import { chartSummary } from './text';
import { CHART_AXIS, CHART_LABEL, CHART_VAR } from './tokens';
import type { ChartSeries } from './types';

export type StackedLinesProps = {
  title: string;
  labels: string[];
  series: ChartSeries[]; // one row each, in this order
  xTitle: string;
  yTitle: string; // required (D11)
  unit?: string;
  formatValue?: (v: number) => string; // default formatCount
  partialLast?: boolean;
  width?: number; // floor plot width in px
  rowHeight?: number; // each row's plot height in px (default 96)
};

const HEADING = 18;
const LABEL_ROOM = LABEL_BOX_HEIGHT + 8;
const TITLE_BAND = 20;

/**
 * Small multiples, not a stacked area: one line per row, stacked top to
 * bottom on one shared value scale and one shared x axis. Used where four or
 * more series would make one plot unreadable (#16 by source, failures by
 * lane). Each row is named next to its swatch; every point carries its value.
 */
export function StackedLines({
  title,
  labels,
  series,
  xTitle,
  yTitle,
  unit = '',
  formatValue = formatCount,
  partialLast = false,
  width,
  rowHeight = 96,
}: StackedLinesProps) {
  const count = labels.length;
  const plotWidth = width ?? minPlotWidth(count, 1);
  const range = axisRange(series.flatMap((s) => s.values));
  const edgeTicks = [range.ticks[0], range.ticks[range.ticks.length - 1]];
  const tickTexts = edgeTicks.map((t) => formatTick(t, unit));
  const tickBand = Math.max(...tickTexts.map((t) => estimateTextWidth(t))) + 8;
  const fractions = pointFractions(count);
  const hollow = hollowFlags(count, partialLast);

  const rows = series.map((s) => {
    const ys = s.values.map((v) => (v === null ? null : yPx(v, range, rowHeight)));
    const sides = preferredSides(ys);
    const points: LabelPoint[] = [];
    const markers: Box[] = [];
    const marks: { key: string; fraction: number; y: number; hollow: boolean }[] = [];
    s.values.forEach((v, i) => {
      if (v === null) return;
      const x = fractions[i] * plotWidth;
      const y = yPx(v, range, rowHeight);
      points.push({ x, y, text: withUnit(formatValue(v), unit), above: sides[i] });
      markers.push({ x0: x - MARKER_HALF, y0: y - MARKER_HALF, x1: x + MARKER_HALF, y1: y + MARKER_HALF });
      marks.push({ key: `${s.key}-${i}`, fraction: fractions[i], y, hollow: hollow[i] });
    });
    const placement = placeValueLabels(points, { x0: 0, y0: -LABEL_ROOM, x1: plotWidth, y1: rowHeight }, { obstacles: markers });
    return { s, points, marks, placement, room: Math.max(LABEL_ROOM, Math.ceil(-placement.top) + 2) };
  });

  const template = rows.map((row) => `${HEADING}px ${row.room}px ${rowHeight}px`).join(' ');
  const plotRows = `1 / ${1 + rows.length * 3}`;
  const xTicks = xTickIndices(labels, fractions, plotWidth).map((i) => ({ fraction: fractions[i], text: labels[i] }));
  const tickYs = edgeTicks.map((t) => yPx(t, range, rowHeight));

  return (
    <div className="flex min-w-0 flex-col gap-2" data-chart="stacked-lines">
      <ChartScroll title={title}>
        <div
          role="img"
          aria-label={chartSummary(title, labels, series, formatValue, unit, partialLast)}
          className="grid"
          style={{
            gridTemplateColumns: `${TITLE_BAND}px ${tickBand}px minmax(${plotWidth}px, 1fr) ${MARKER_HALF + 2}px`,
            gridTemplateRows: `${template} ${LABEL_BOX_HEIGHT + 8}px auto`,
          }}
        >
          <div
            data-axis-title="y"
            className="flex items-center justify-center text-center font-bold"
            style={{ gridColumn: '1', gridRow: plotRows, writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 11, color: CHART_AXIS }}
          >
            {yTitle}
          </div>
          {rows.map((row, r) => {
            const base = 1 + r * 3;
            return (
              <div key={row.s.key} className="contents">
                <div
                  data-row-label=""
                  className="flex items-center gap-1.5 text-xs font-semibold"
                  style={{ gridColumn: '3', gridRow: String(base), color: CHART_LABEL }}
                >
                  <span aria-hidden="true" className="inline-block h-0.5 w-3.5 rounded" style={{ background: CHART_VAR[row.s.color] }} />
                  {row.s.label}
                </div>
                <YTicks gridRow={String(base + 2)} ticks={edgeTicks.map((_, k) => ({ y: tickYs[k], text: tickTexts[k] }))} />
                <div className="relative" style={{ gridColumn: '3', gridRow: String(base + 2) }}>
                  <PlotSvg plotHeight={rowHeight}>
                    <GridLines ys={tickYs} plotHeight={rowHeight} />
                    <path
                      d={scaledLinePath(row.s.values, fractions, range, rowHeight)}
                      fill="none"
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                      style={{ stroke: CHART_VAR[row.s.color] }}
                    />
                  </PlotSvg>
                  {row.marks.map((m) => (
                    <Marker key={m.key} fraction={m.fraction} y={m.y} color={CHART_VAR[row.s.color]} hollow={m.hollow} />
                  ))}
                  <ValueLabels labels={row.placement.labels} plotWidth={plotWidth} pointYs={row.points.map((p) => p.y - MARKER_HALF)} />
                </div>
              </div>
            );
          })}
          <XTicks ticks={xTicks} plotWidth={plotWidth} gridRow={String(1 + rows.length * 3)} />
          <div
            data-axis-title="x"
            className="text-center font-bold"
            style={{ gridColumn: '3', gridRow: String(2 + rows.length * 3), fontSize: 11, color: CHART_AXIS, paddingTop: 4 }}
          >
            {xTitle}
          </div>
        </div>
      </ChartScroll>
      <ChartLegend items={lineLegend(series, partialLast)} />
    </div>
  );
}
