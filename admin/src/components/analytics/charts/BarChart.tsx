import { formatCount } from '@/lib/analytics-format';
import {
  LABEL_BOX_HEIGHT,
  axisRange,
  barThickness,
  figureLayout,
  formatTick,
  hollowFlags,
  minBarPlotWidth,
  placeValueLabels,
  slotFractions,
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
  PlotSvg,
  ValueLabels,
  XAxisTitle,
  XTicks,
  YAxisTitle,
  YTicks,
  anchoredLeft,
} from './axes';
import { ChartLegend, lineLegend } from './ChartLegend';
import { chartSummary } from './text';
import { HBarFigure } from './HBarFigure';
import { CHART_SURFACE, CHART_VAR, HOLLOW_BAR_NOTE } from './tokens';
import type { ChartSeries } from './types';

export type BarChartProps = {
  title: string;
  orientation?: 'vertical' | 'horizontal'; // default vertical (columns over time)
  labels: string[]; // x buckets (vertical) or row names (horizontal), in order
  series: ChartSeries[]; // 1–3; two or more draw grouped bars with a legend
  xTitle: string;
  yTitle: string; // required (D11)
  unit?: string;
  formatValue?: (v: number) => string; // default formatCount
  partialLast?: boolean; // vertical only: the last bar hollow + "Hollow bar = current week so far"
  width?: number; // floor width of the plot in px
  height?: number; // vertical: plot height in px
};

const LABEL_ROOM = LABEL_BOX_HEIGHT + 8;

export function BarChart(props: BarChartProps) {
  return props.orientation === 'horizontal' ? <HorizontalBars {...props} /> : <VerticalBars {...props} />;
}

// Columns: 4px rounded caps, square at the baseline, ≤24px thick; the value
// sits above every column (never inside it); a hollow column for the partial week.
function VerticalBars({
  title,
  labels,
  series,
  xTitle,
  yTitle,
  unit = '',
  formatValue = formatCount,
  partialLast = false,
  width,
  height,
}: BarChartProps) {
  const count = labels.length;
  const group = Math.max(1, series.length);
  const plotWidth = width ?? minBarPlotWidth(count, group);
  const range = axisRange(series.flatMap((s) => s.values));
  const tickTexts = range.ticks.map((t) => formatTick(t, unit));
  const plotHeight = figureLayout({ plotWidth, plotHeight: height ?? 200, topSpace: LABEL_ROOM, yTickLabels: tickTexts, yTitle, xTitle }).plotHeight;
  const fractions = slotFractions(count);
  const thickness = barThickness(count > 0 ? plotWidth / count : plotWidth, group);
  const hollow = hollowFlags(count, partialLast);

  const bars: { key: string; fraction: number; offset: number; y: number; color: string; hollow: boolean }[] = [];
  const boxes: Box[] = [];
  const points: LabelPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    series.forEach((s, si) => {
      const v = s.values[i] ?? null;
      if (v === null) return;
      // Bars of one bucket sit side by side, 2px apart, centred on the slot.
      const centre = (si - (group - 1) / 2) * (thickness + 2);
      const x = fractions[i] * plotWidth + centre;
      const y = yPx(v, range, plotHeight);
      bars.push({ key: `${s.key}-${i}`, fraction: fractions[i], offset: thickness / 2 - centre, y, color: CHART_VAR[s.color], hollow: hollow[i] });
      boxes.push({ x0: x - thickness / 2, y0: y, x1: x + thickness / 2, y1: plotHeight });
      points.push({ x, y, text: withUnit(formatValue(v), unit) });
    });
  }
  const placement = placeValueLabels(points, { x0: 0, y0: -LABEL_ROOM, x1: plotWidth, y1: plotHeight }, { sides: 'above', obstacles: boxes, gap: 4 });
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
    <div className="flex min-w-0 flex-col gap-2" data-chart="bar-vertical">
      <ChartScroll title={title}>
        <Figure label={chartSummary(title, labels, series, formatValue, unit, partialLast)} layout={layout}>
          <YAxisTitle text={yTitle} />
          <YTicks ticks={range.ticks.map((_, k) => ({ y: tickYs[k], text: tickTexts[k] }))} />
          <div className="relative" style={{ gridColumn: '3', gridRow: '2' }}>
            <PlotSvg plotHeight={plotHeight}>
              <GridLines ys={tickYs} plotHeight={plotHeight} />
            </PlotSvg>
            {bars.map((bar) => (
              <span
                key={bar.key}
                aria-hidden="true"
                data-bar=""
                data-hollow={bar.hollow ? 'true' : 'false'}
                style={{
                  position: 'absolute',
                  left: anchoredLeft(bar.fraction, bar.offset),
                  top: bar.y,
                  width: thickness,
                  height: Math.max(0, plotHeight - bar.y),
                  boxSizing: 'border-box',
                  borderRadius: '4px 4px 0 0',
                  background: bar.hollow ? CHART_SURFACE : bar.color,
                  border: bar.hollow ? `2px solid ${bar.color}` : undefined,
                  borderBottom: 'none',
                }}
              />
            ))}
            <ValueLabels labels={placement.labels} plotWidth={plotWidth} pointYs={points.map((p) => p.y)} />
          </div>
          <XTicks ticks={xTicks} plotWidth={plotWidth} />
          <XAxisTitle text={xTitle} />
        </Figure>
      </ChartScroll>
      <ChartLegend items={lineLegend(series, partialLast, HOLLOW_BAR_NOTE)} />
    </div>
  );
}

// Bars along rows (ages, reasons, steps): see HBarFigure.
function HorizontalBars({ title, labels, series, xTitle, yTitle, unit = '', formatValue = formatCount }: BarChartProps) {
  const range = axisRange(series.flatMap((s) => s.values));
  const span = range.max - range.min || 1;
  return (
    <div data-chart="bar-horizontal">
      <HBarFigure
        title={title}
        summary={chartSummary(title, labels, series, formatValue, unit)}
        rows={labels.map((label, i) => ({
          label,
          bars: series.map((s) => {
            const v = s.values[i] ?? null;
            return {
              key: s.key,
              color: s.color,
              part: v === null ? 0 : (v - range.min) / span,
              text: v === null ? null : withUnit(formatValue(v), unit),
            };
          }),
        }))}
        ticks={range.ticks.map((t) => ({ fraction: (t - range.min) / span, text: formatTick(t, unit) }))}
        xTitle={xTitle}
        yTitle={yTitle}
        legend={lineLegend(series, false)}
      />
    </div>
  );
}
