import { formatCount } from '@/lib/analytics-format';
import {
  LABEL_BOX_HEIGHT,
  MARKER_HALF,
  axisRange,
  figureLayout,
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
  Figure,
  GridLines,
  Marker,
  PlotSvg,
  ValueLabels,
  XAxisTitle,
  XTicks,
  YAxisTitle,
  YTicks,
} from './axes';
import { ChartLegend, lineLegend } from './ChartLegend';
import { chartSummary } from './text';
import { CHART_VAR } from './tokens';
import type { ChartSeries } from './types';

export type LineChartProps = {
  title: string; // for role="img" aria-label (plus the latest value)
  labels: string[]; // x bucket labels, oldest first
  series: ChartSeries[];
  xTitle: string;
  yTitle: string; // required (D11)
  unit?: string; // appended to ticks and value labels, e.g. "%", "h"
  formatValue?: (v: number) => string; // default formatCount
  partialLast?: boolean; // hollow last point + legend note "Hollow point = current week so far"
  yMin?: number; // default 0; #10 uses 80 with its caption
  width?: number; // the plot's floor width in px (default: room for every label)
  height?: number; // the plot height in px
};

// Room above the plot for one row of labels over the highest points.
export const LABEL_ROOM = LABEL_BOX_HEIGHT + 8;

/**
 * D11 line chart (1–3 series; four or more go to StackedLines): both axes
 * titled, ticks with units, a value on every point, the partial last point
 * hollow, a legend for two or more series, role="img" with the latest values.
 * The table twin is the ChartFrame's.
 */
export function LineChart({
  title,
  labels,
  series,
  xTitle,
  yTitle,
  unit = '',
  formatValue = formatCount,
  partialLast = false,
  yMin = 0,
  width,
  height,
}: LineChartProps) {
  const count = labels.length;
  const plotWidth = width ?? minPlotWidth(count, series.length);
  const range = axisRange(series.flatMap((s) => s.values), yMin);
  const tickTexts = range.ticks.map((t) => formatTick(t, unit));
  const sized = figureLayout({
    plotWidth,
    plotHeight: height ?? 200 + 40 * Math.max(0, series.length - 1),
    topSpace: LABEL_ROOM,
    yTickLabels: tickTexts,
    yTitle,
    xTitle,
  });
  const plotHeight = sized.plotHeight;
  const fractions = pointFractions(count);
  const hollow = hollowFlags(count, partialLast);
  const sides = series.map((s) => preferredSides(s.values.map((v) => (v === null ? null : yPx(v, range, plotHeight)))));

  const points: LabelPoint[] = [];
  const markers: Box[] = [];
  const marks: { key: string; fraction: number; y: number; color: string; hollow: boolean }[] = [];
  for (let i = 0; i < count; i += 1) {
    series.forEach((s, si) => {
      const v = s.values[i] ?? null;
      if (v === null) return;
      const x = fractions[i] * plotWidth;
      const y = yPx(v, range, plotHeight);
      points.push({ x, y, text: withUnit(formatValue(v), unit), above: sides[si][i] });
      markers.push({ x0: x - MARKER_HALF, y0: y - MARKER_HALF, x1: x + MARKER_HALF, y1: y + MARKER_HALF });
      marks.push({ key: `${s.key}-${i}`, fraction: fractions[i], y, color: CHART_VAR[s.color], hollow: hollow[i] });
    });
  }
  const placement = placeValueLabels(points, { x0: 0, y0: -LABEL_ROOM, x1: plotWidth, y1: plotHeight }, { obstacles: markers });
  const layout = figureLayout({
    plotWidth,
    plotHeight,
    topSpace: Math.max(LABEL_ROOM, Math.ceil(-placement.top) + 2),
    yTickLabels: tickTexts,
    yTitle,
    xTitle,
  });
  const tickYs = range.ticks.map((t) => yPx(t, range, plotHeight));
  const xTicks = xTickIndices(labels, fractions, plotWidth).map((i) => ({ fraction: fractions[i], text: labels[i] }));

  return (
    <div className="flex min-w-0 flex-col gap-2" data-chart="line">
      <ChartScroll title={title}>
        <Figure label={chartSummary(title, labels, series, formatValue, unit, partialLast)} layout={layout}>
          <YAxisTitle text={yTitle} />
          <YTicks ticks={range.ticks.map((_, k) => ({ y: tickYs[k], text: tickTexts[k] }))} />
          <div className="relative" style={{ gridColumn: '3', gridRow: '2' }}>
            <PlotSvg plotHeight={plotHeight}>
              <GridLines ys={tickYs} plotHeight={plotHeight} />
              {series.map((s) => (
                <path
                  key={s.key}
                  d={scaledLinePath(s.values, fractions, range, plotHeight)}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ stroke: CHART_VAR[s.color] }}
                />
              ))}
            </PlotSvg>
            {marks.map((m) => (
              <Marker key={m.key} fraction={m.fraction} y={m.y} color={m.color} hollow={m.hollow} />
            ))}
            <ValueLabels labels={placement.labels} plotWidth={plotWidth} pointYs={points.map((p) => p.y - MARKER_HALF)} />
          </div>
          <XTicks ticks={xTicks} plotWidth={plotWidth} />
          <XAxisTitle text={xTitle} />
        </Figure>
      </ChartScroll>
      <ChartLegend items={lineLegend(series, partialLast)} />
    </div>
  );
}
