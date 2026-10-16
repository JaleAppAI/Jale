import type { CSSProperties, ReactNode } from 'react';
import {
  LABEL_BOX_HEIGHT,
  clampSpan,
  estimateTextWidth,
  type FigureLayout,
  type PlacedLabel,
} from '@/lib/chart-geometry';
import { CHART_AXIS, CHART_GRID, CHART_LABEL, CHART_SURFACE } from './tokens';

// Shared pieces of the D11 cartesian figure: a CSS grid of
//   [y title] [y ticks] [plot]        row 1: room above the plot for labels
//                                     row 2: the plot
//                                     row 3: x ticks
//                                     row 4: x title
// Marks are SVG stretched over the plot; all text is HTML at a fixed pixel size.

export const TEXT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: `${LABEL_BOX_HEIGHT}px`,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};

// A box tied to a fraction of the plot width with a fixed pixel offset: the
// same rule the geometry checks prove (wider plots only spread boxes apart).
export function anchoredLeft(fraction: number, offsetPx: number): string {
  return `calc(${(fraction * 100).toFixed(3)}% - ${offsetPx.toFixed(1)}px)`;
}

export function Figure({ label, layout, children }: { label: string; layout: FigureLayout; children: ReactNode }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="grid"
      style={{
        gridTemplateColumns: `${layout.yTitleBand}px ${layout.yTickBand}px minmax(${layout.plotWidth}px, 1fr) ${layout.rightGutter}px`,
        gridTemplateRows: `${layout.topSpace}px ${layout.plotHeight}px ${layout.xTickBand}px auto`,
      }}
    >
      {children}
    </div>
  );
}

// The figure's scroll region: below its floor width the chart scrolls here,
// never the page.
export function ChartScroll({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={`${title} chart`} tabIndex={0} className="min-w-0 overflow-x-auto">
      {children}
    </div>
  );
}

export function YAxisTitle({ text, gridRow = '2' }: { text: string; gridRow?: string }) {
  return (
    <div
      data-axis-title="y"
      className="flex items-center justify-center text-center font-bold"
      style={{ gridColumn: '1', gridRow, writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: 11, color: CHART_AXIS }}
    >
      {text}
    </div>
  );
}

export function XAxisTitle({ text }: { text: string }) {
  return (
    <div data-axis-title="x" className="text-center font-bold" style={{ gridColumn: '3', gridRow: '4', fontSize: 11, color: CHART_AXIS, paddingTop: 4 }}>
      {text}
    </div>
  );
}

// Tick labels on the value axis, right-aligned against the plot.
export function YTicks({ ticks, gridRow = '2' }: { ticks: { y: number; text: string }[]; gridRow?: string }) {
  return (
    <div className="relative" style={{ gridColumn: '2', gridRow }}>
      {ticks.map((tick) => (
        <span
          key={`${tick.text}-${tick.y}`}
          data-tick="y"
          style={{ ...TEXT_STYLE, position: 'absolute', right: 8, top: tick.y - LABEL_BOX_HEIGHT / 2, color: CHART_AXIS }}
        >
          {tick.text}
        </span>
      ))}
    </div>
  );
}

// Tick labels under the plot at the given fractions, each kept inside the plot.
export function XTicks({
  ticks,
  plotWidth,
  gridRow = '3',
}: {
  ticks: { fraction: number; text: string }[];
  plotWidth: number;
  gridRow?: string;
}) {
  return (
    <div className="relative" style={{ gridColumn: '3', gridRow }}>
      {ticks.map((tick) => {
        const width = estimateTextWidth(tick.text);
        const x = tick.fraction * plotWidth;
        const span = clampSpan(x, width, 0, plotWidth);
        return (
          <span
            key={`${tick.text}-${tick.fraction}`}
            data-tick="x"
            style={{ ...TEXT_STYLE, position: 'absolute', top: 6, left: anchoredLeft(tick.fraction, x - span.x0), width, textAlign: 'center', color: CHART_AXIS }}
          >
            {tick.text}
          </span>
        );
      })}
    </div>
  );
}

// Horizontal gridlines (the lowest one is the axis line), in a viewBox the
// plot stretches; strokes keep 1px at every width.
export function GridLines({ ys, plotHeight }: { ys: number[]; plotHeight: number }) {
  return (
    <>
      {ys.map((y) => (
        <line
          key={y}
          x1={0}
          x2={1000}
          y1={y}
          y2={y}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={{ stroke: Math.abs(y - plotHeight) < 0.5 ? CHART_AXIS : CHART_GRID }}
        />
      ))}
    </>
  );
}

export function PlotSvg({ plotHeight, children }: { plotHeight: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 1000 ${plotHeight}`}
      preserveAspectRatio="none"
      width="100%"
      height={plotHeight}
      style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
    >
      {children}
    </svg>
  );
}

// One value label per placed box. A label pushed to a lane above the plot
// gets a hairline back to its point.
export function ValueLabels({
  labels,
  plotWidth,
  pointYs,
}: {
  labels: (PlacedLabel | null)[];
  plotWidth: number;
  pointYs: number[];
}) {
  return (
    <>
      {labels.map((label, k) => {
        if (label === null) return null;
        const fraction = plotWidth > 0 ? label.x / plotWidth : 0;
        const width = label.box.x1 - label.box.x0;
        return (
          <span key={`v${k}`}>
            {label.lane ? (
              <span
                aria-hidden="true"
                data-leader=""
                style={{
                  position: 'absolute',
                  left: anchoredLeft(fraction, 0.5),
                  top: label.box.y1,
                  width: 1,
                  height: Math.max(0, pointYs[k] - label.box.y1),
                  background: CHART_AXIS,
                }}
              />
            ) : null}
            <span
              data-value-label=""
              className="font-semibold"
              style={{
                ...TEXT_STYLE,
                position: 'absolute',
                left: anchoredLeft(fraction, label.x - label.box.x0),
                top: label.box.y0,
                width,
                textAlign: 'center',
                color: CHART_LABEL,
              }}
            >
              {label.text}
            </span>
          </span>
        );
      })}
    </>
  );
}

// An 8px point with a 2px ring in the card colour; hollow for the partial bucket.
export function Marker({ fraction, y, color, hollow }: { fraction: number; y: number; color: string; hollow: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-marker=""
      data-hollow={hollow ? 'true' : 'false'}
      style={{
        position: 'absolute',
        left: anchoredLeft(fraction, 4),
        top: y - 4,
        width: 8,
        height: 8,
        boxSizing: 'border-box',
        borderRadius: 9999,
        boxShadow: `0 0 0 2px ${CHART_SURFACE}`,
        background: hollow ? CHART_SURFACE : color,
        border: hollow ? `2px solid ${color}` : undefined,
      }}
    />
  );
}
