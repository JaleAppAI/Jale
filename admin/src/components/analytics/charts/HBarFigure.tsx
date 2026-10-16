import { LABEL_BOX_HEIGHT, clampSpan, estimateTextWidth, xTickIndices } from '@/lib/chart-geometry';
import { ChartScroll, TEXT_STYLE } from './axes';
import { ChartLegend } from './ChartLegend';
import { CHART_AXIS, CHART_LABEL, CHART_VAR } from './tokens';
import type { ChartColor, LegendItem } from './types';

export type HBar = { key: string; color: ChartColor; part: number; text: string | null };
export type HBarRow = { label: string; bars: HBar[] };

const ROW_LABEL_MIN = 72;
const VALUE_GAP = 6;
const TRACK_FLOOR = 120;

/**
 * Rows of horizontal bars (BarChart horizontal, FunnelChart). `part` is the
 * bar's share of the track (0–1). Every value sits just past its bar's end in
 * a gutter wide enough for the longest value, so no value is ever clipped or
 * drawn over a bar; bars of one row are a label-height apart, rows further,
 * so no two values can touch. x ticks are thinned until they do not touch.
 */
export function HBarFigure({
  title,
  summary,
  rows,
  ticks,
  xTitle,
  yTitle,
  legend,
}: {
  title: string;
  summary: string;
  rows: HBarRow[];
  ticks: { fraction: number; text: string }[];
  xTitle: string;
  yTitle: string;
  legend: LegendItem[];
}) {
  const group = Math.max(1, ...rows.map((row) => row.bars.length));
  const thickness = group === 1 ? 20 : LABEL_BOX_HEIGHT;
  const rowHeight = group * (thickness + 2) + 10;
  const longest = Math.max(24, ...rows.flatMap((row) => row.bars.map((bar) => (bar.text === null ? 0 : estimateTextWidth(bar.text)))));
  const gutter = longest + VALUE_GAP + 4;
  const barArea = TRACK_FLOOR;
  const trackFloor = barArea + gutter;
  const shown = xTickIndices(
    ticks.map((t) => t.text),
    ticks.map((t) => t.fraction),
    barArea,
  );
  const along = (part: number, extraPx: number) =>
    `calc((100% - ${gutter}px) * ${Math.max(0, Math.min(1, part)).toFixed(4)} + ${extraPx.toFixed(1)}px)`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChartScroll title={title}>
        <div
          role="img"
          aria-label={summary}
          className="grid items-center"
          style={{ gridTemplateColumns: `minmax(${ROW_LABEL_MIN}px, 30%) minmax(${trackFloor}px, 1fr)` }}
        >
          <div
            data-axis-title="y"
            className="font-bold uppercase"
            style={{ gridColumn: '1', fontSize: 11, letterSpacing: '0.06em', color: CHART_AXIS, paddingBottom: 6 }}
          >
            {yTitle}
          </div>
          <div style={{ gridColumn: '2' }} />
          {rows.map((row, i) => (
            <div key={`${row.label}-${i}`} className="contents">
              <div className="pr-2 text-xs [overflow-wrap:anywhere]" style={{ gridColumn: '1', color: CHART_LABEL }}>
                {row.label}
              </div>
              <div className="relative" style={{ gridColumn: '2', height: rowHeight, borderLeft: `1px solid ${CHART_AXIS}` }}>
                {row.bars.map((bar, b) => {
                  const top = 5 + b * (thickness + 2);
                  return (
                    <span key={bar.key}>
                      <span
                        aria-hidden="true"
                        data-bar=""
                        style={{
                          position: 'absolute',
                          left: 0,
                          top,
                          height: thickness,
                          width: along(bar.part, 0),
                          borderRadius: '0 4px 4px 0',
                          background: CHART_VAR[bar.color],
                        }}
                      />
                      {bar.text === null ? null : (
                        <span
                          data-value-label=""
                          className="font-semibold"
                          style={{
                            ...TEXT_STYLE,
                            position: 'absolute',
                            top: top + (thickness - LABEL_BOX_HEIGHT) / 2,
                            left: along(bar.part, VALUE_GAP),
                            color: CHART_LABEL,
                          }}
                        >
                          {bar.text}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          <div style={{ gridColumn: '1' }} />
          <div className="relative" style={{ gridColumn: '2', height: LABEL_BOX_HEIGHT + 8 }}>
            {shown.map((k) => {
              const tick = ticks[k];
              const w = estimateTextWidth(tick.text);
              const x = tick.fraction * barArea;
              const span = clampSpan(x, w, 0, barArea);
              return (
                <span
                  key={`${tick.text}-${k}`}
                  data-tick="x"
                  style={{ ...TEXT_STYLE, position: 'absolute', top: 4, left: along(tick.fraction, span.x0 - x), width: w, textAlign: 'center', color: CHART_AXIS }}
                >
                  {tick.text}
                </span>
              );
            })}
          </div>
          <div style={{ gridColumn: '1' }} />
          <div data-axis-title="x" className="text-center font-bold" style={{ gridColumn: '2', fontSize: 11, color: CHART_AXIS, paddingRight: gutter }}>
            {xTitle}
          </div>
        </div>
      </ChartScroll>
      <ChartLegend items={legend} />
    </div>
  );
}
