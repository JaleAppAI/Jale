/**
 * Pure SVG geometry for the analytics charts. No React, no DOM: every function
 * maps numbers to path strings or coordinates so the check script can pin the
 * exact output. Sizes are the SVG plot area (width × height); `max` is the
 * axis maximum from `niceMax`. A `null` value is a gap (no data for that
 * bucket), never a zero.
 */

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const fmt = (n: number): string => n.toFixed(1);

export function niceMax(values: (number | null)[]): number {
  const max = values.reduce<number>((acc, v) => (v !== null && v > acc ? v : acc), 0);
  if (max <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= max) return Number(candidate.toPrecision(12));
  }
  return 10 * magnitude;
}

// How many intervals to split the axis into so every tick is a round number:
// the first count whose step is 1, 2 or 5 times a power of ten, else the
// first count. niceMax values always find one among 3, 4, 5, 6.
export function tickIntervals(max: number, counts: number[] = [3, 4, 5, 6]): number {
  const round = counts.find((n) => {
    const step = max / n;
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    return [1, 2, 5, 10].some((nice) => Math.abs(mantissa - nice) < 1e-9);
  });
  return round ?? counts[0];
}

export function tickValues(max: number, intervals = 3): number[] {
  const ticks: number[] = [];
  for (let i = 0; i <= intervals; i += 1) {
    ticks.push(Math.round(((max * i) / intervals) * 1000) / 1000);
  }
  return ticks;
}

export function xPositions(count: number, width: number): number[] {
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => (i * width) / (count - 1));
}

function yFor(value: number, height: number, max: number): number {
  return height - (value / max) * height;
}

// A null lifts the pen: each run of values starts with a move, so no segment
// is drawn through a gap. All-number input gives exactly one run.
export function linePath(values: (number | null)[], width: number, height: number, max: number): string {
  const xs = xPositions(values.length, width);
  const parts: string[] = [];
  let penDown = false;
  values.forEach((v, i) => {
    if (v === null) {
      penDown = false;
      return;
    }
    parts.push(`${penDown ? 'L' : 'M'}${fmt(xs[i])},${fmt(yFor(v, height, max))}`);
    penDown = true;
  });
  return parts.join(' ');
}

// Points with no value on either side draw no line, so they get a dot. The
// last point is left out: it carries the end dot.
export function isolatedPoints(
  values: (number | null)[],
  width: number,
  height: number,
  max: number,
): { x: number; y: number }[] {
  const xs = xPositions(values.length, width);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < values.length - 1; i += 1) {
    const v = values[i];
    if (v !== null && (i === 0 || values[i - 1] === null) && values[i + 1] === null) {
      points.push({ x: xs[i], y: yFor(v, height, max) });
    }
  }
  return points;
}

export function areaPath(values: number[], width: number, height: number, max: number): string {
  return `${linePath(values, width, height, max)} L${width},${height} L0,${height} Z`;
}

export function endPoint(values: (number | null)[], width: number, height: number, max: number): { x: number; y: number } {
  const xs = xPositions(values.length, width);
  const last = values[values.length - 1] ?? 0;
  return { x: xs[xs.length - 1], y: yFor(last, height, max) };
}

export type ColumnOptions = { maxThickness?: number; radius?: number; gap?: number };

// One path per non-zero bucket: a column that grows from a square baseline to a
// rounded cap. Zero buckets draw nothing rather than a zero-height sliver.
export function columnPaths(
  values: number[],
  width: number,
  height: number,
  max: number,
  { maxThickness = 24, radius = 4, gap = 4 }: ColumnOptions = {},
): string[] {
  const slot = width / values.length;
  const thickness = Math.max(1, Math.min(maxThickness, slot - gap));
  const r = Math.min(radius, thickness / 2);
  const paths: string[] = [];
  values.forEach((v, i) => {
    if (v <= 0) return;
    const x = i * slot + (slot - thickness) / 2;
    const y = yFor(v, height, max);
    const shoulder = Math.min(y + r, height);
    paths.push(
      `M${fmt(x)},${height} L${fmt(x)},${fmt(shoulder)} Q${fmt(x)},${fmt(y)} ${fmt(x + r)},${fmt(y)}` +
        ` L${fmt(x + thickness - r)},${fmt(y)} Q${fmt(x + thickness)},${fmt(y)} ${fmt(x + thickness)},${fmt(shoulder)}` +
        ` L${fmt(x + thickness)},${height} Z`,
    );
  });
  return paths;
}

// Indices for ~`target` x-axis labels, always including the first and last bucket.
export function labelIndices(count: number, target = 5): number[] {
  if (count <= 1) return [0];
  const wanted = Math.min(target, count);
  const indices = new Set<number>();
  for (let i = 0; i < wanted; i += 1) {
    indices.add(Math.round((i * (count - 1)) / (wanted - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

// Baselines for end-of-line labels: keep neighbours at least `minGap` apart
// without reordering, and never below `maxY` (the zero baseline).
export function spreadLabels(ys: number[], minGap: number, maxY: number): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b] || a - b);
  const out = [...ys];
  for (let k = 1; k < order.length; k += 1) {
    out[order[k]] = Math.max(out[order[k]], out[order[k - 1]] + minGap);
  }
  for (let k = order.length - 1; k >= 0; k -= 1) {
    const limit = k === order.length - 1 ? maxY : out[order[k + 1]] - minGap;
    out[order[k]] = Math.min(out[order[k]], limit);
  }
  return out;
}

// ---- D11 (Sprint 28): value labels, axes and scales ----------------------------
// The D11 charts draw marks (lines, bars, gridlines) in SVG and every piece of
// text (value labels, ticks, axis titles) in HTML, so text keeps its pixel size
// at every width. Text boxes are laid out in pixels at the chart's floor width.
// An x position is a fraction of the plot width and a box keeps a fixed pixel
// offset from it, so a wider plot only moves boxes further apart: a layout with
// no overlaps at the floor width has none at any wider width.

export type Box = { x0: number; y0: number; x1: number; y1: number };

export const LABEL_FONT_PX = 11;
export const LABEL_BOX_HEIGHT = 14;
// Half the size of a point marker: an 8px dot plus its 2px surface ring.
export const MARKER_HALF = 6;

const NARROW_CHARS = new Set([',', '.', ':', ';', ' ', '·', "'", '|', '!', 'i', 'l', 'j', 't', 'f', 'r', '(', ')', '-']);
const WIDE_CHARS = new Set(['%', 'M', 'W', 'm', 'w', '—', '@']);

// A deliberate over-estimate of rendered width (Lexend, tabular figures), so a
// box always holds its text. The browser pass measures the real glyphs.
export function estimateTextWidth(text: string, fontPx: number = LABEL_FONT_PX): number {
  let em = 0;
  for (const ch of text) {
    em += NARROW_CHARS.has(ch) ? 0.4 : WIDE_CHARS.has(ch) ? 0.95 : 0.7;
  }
  return Math.ceil(em * fontPx);
}

// Two boxes overlap when they come closer than `pad` on both axes; boxes
// exactly `pad` apart do not overlap.
export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
}

// A box `width` wide centred on `x`, shifted to stay inside [min, max].
export function clampSpan(x: number, width: number, min: number, max: number): { x0: number; x1: number } {
  const x0 = Math.max(min, Math.min(x - width / 2, max - width));
  return { x0, x1: x0 + width };
}

// The plot's floor width in pixels: room for every point's label and marker.
// Below it the chart scrolls inside its own region; above it, it stretches.
export function minPlotWidth(points: number, seriesCount = 1): number {
  const perPoint = 10 + 6 * Math.max(1, seriesCount);
  return Math.min(640, Math.max(200, points * perPoint));
}

// Point positions as fractions of the plot width: one point sits in the middle.
export function pointFractions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0.5];
  return Array.from({ length: count }, (_, i) => i / (count - 1));
}

// Slot centres for bars, as fractions of the plot width.
export function slotFractions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 0.5) / count);
}

// Only the last bucket can be partial (the current week so far).
export function hollowFlags(count: number, partialLast: boolean): boolean[] {
  return Array.from({ length: count }, (_, i) => partialLast && i === count - 1);
}

// ---- Value-label placement ----
export type LabelPoint = { x: number; y: number; text: string; above?: boolean };
export type PlacedLabel = { text: string; x: number; box: Box; lane: boolean };
export type LabelPlacement = { labels: (PlacedLabel | null)[]; top: number };
export type PlaceOptions = {
  fontPx?: number;
  // Distance from the point to the near edge of its label.
  gap?: number;
  // Minimum clearance between two labels, and between a label and an obstacle.
  pad?: number;
  // 'above' for bars (a label never sits inside its bar).
  sides?: 'both' | 'above';
  // Marks a label must not cover: point markers, bars.
  obstacles?: Box[];
};

/**
 * One label per point, none overlapping another label or an obstacle. Each
 * label tries rows next to its point, nearest first: its preferred side, then
 * the other side, then one row further out, and so on, inside `area`. A label
 * that finds no free row inside `area` goes to the first free lane above the
 * area (`lane: true`); `top` is then above `area.y0`, and the chart grows its
 * top margin to fit. Lanes never run out, so every point gets its label.
 * Points are placed in input order; `above` (default true) is the preferred side.
 */
export function placeValueLabels(points: (LabelPoint | null)[], area: Box, options: PlaceOptions = {}): LabelPlacement {
  const { fontPx = LABEL_FONT_PX, gap = MARKER_HALF + 2, pad = 2, sides = 'both', obstacles = [] } = options;
  const height = Math.max(LABEL_BOX_HEIGHT, Math.ceil(fontPx * 1.25));
  const placed: Box[] = [];
  let top = area.y0;
  const free = (box: Box): boolean =>
    !placed.some((other) => boxesOverlap(box, other, pad)) && !obstacles.some((other) => boxesOverlap(box, other, pad));

  const labels = points.map((point) => {
    if (point === null) return null;
    const width = estimateTextWidth(point.text, fontPx);
    const { x0, x1 } = clampSpan(point.x, width, area.x0, area.x1);
    const above = (k: number): Box => {
      const y1 = point.y - gap - k * (height + pad);
      return { x0, x1, y0: y1 - height, y1 };
    };
    const below = (k: number): Box => {
      const y0 = point.y + gap + k * (height + pad);
      return { x0, x1, y0, y1: y0 + height };
    };
    const preferAbove = sides === 'above' || point.above !== false;
    for (let k = 0; ; k += 1) {
      const first = preferAbove ? above(k) : below(k);
      const second = sides === 'above' ? null : preferAbove ? below(k) : above(k);
      const candidates = [first, second].filter((box): box is Box => box !== null);
      const inside = candidates.filter((box) => box.y0 >= area.y0 && box.y1 <= area.y1);
      const outOfRoom = candidates.every((box) => box.y1 <= area.y0 || box.y0 >= area.y1);
      const hit = inside.find(free);
      if (hit) {
        placed.push(hit);
        return { text: point.text, x: point.x, box: hit, lane: false };
      }
      if (outOfRoom) break;
    }
    for (let lane = 0; ; lane += 1) {
      const y1 = area.y0 - pad - lane * (height + pad);
      const box: Box = { x0, x1, y0: y1 - height, y1 };
      if (free(box)) {
        placed.push(box);
        top = Math.min(top, box.y0);
        return { text: point.text, x: point.x, box, lane: true };
      }
    }
  });
  return { labels, top };
}

// Which side each label prefers: a point at or above the mean of its
// neighbours (a peak, on screen y grows downward) takes the row above it, a
// valley the row below.
export function preferredSides(ys: (number | null)[]): boolean[] {
  return ys.map((y, i) => {
    if (y === null) return true;
    const near = [ys[i - 1], ys[i + 1]].filter((v): v is number => v !== undefined && v !== null);
    if (near.length === 0) return true;
    return y <= near.reduce((a, b) => a + b, 0) / near.length;
  });
}

// ---- Ticks, units and scales ----
export function withUnit(text: string, unit = ''): string {
  return `${text}${unit}`;
}

export function formatTick(
  value: number,
  unit = '',
  format: (v: number) => string = (v) => v.toLocaleString('en-US'),
): string {
  return withUnit(format(value), unit);
}

export type AxisRange = { min: number; max: number; ticks: number[] };

// The value axis. Whole-number data gets whole-number ticks (no "0.333" on a
// count axis). `yMin` raises the floor only when every value is at or above
// it; otherwise the axis starts at 0 (a chart never hides a value below it).
export function axisRange(values: (number | null)[], yMin = 0): AxisRange {
  const present = values.filter((v): v is number => v !== null);
  const floor = yMin > 0 && present.length > 0 && present.every((v) => v >= yMin) ? yMin : 0;
  const whole = present.every((v) => Number.isInteger(v)) && Number.isInteger(floor);
  let span = niceMax(present.map((v) => v - floor));
  if (whole) span = Math.max(1, Math.ceil(span));
  const intervals = whole && span <= 6 ? span : tickIntervals(span);
  const ticks = tickValues(span, intervals).map((t) => Math.round((t + floor) * 1000) / 1000);
  return { min: floor, max: floor + span, ticks };
}

// Pixels from the plot's top edge.
export function yPx(value: number, range: AxisRange, plotHeight: number): number {
  const span = range.max - range.min || 1;
  return plotHeight - ((value - range.min) / span) * plotHeight;
}

// The SVG line of a series in a `scaleX`-wide viewBox (the SVG stretches to the
// plot width; strokes do not scale). A null lifts the pen.
export function scaledLinePath(
  values: (number | null)[],
  fractions: number[],
  range: AxisRange,
  plotHeight: number,
  scaleX = 1000,
): string {
  const parts: string[] = [];
  let penDown = false;
  values.forEach((v, i) => {
    if (v === null) {
      penDown = false;
      return;
    }
    parts.push(`${penDown ? 'L' : 'M'}${fmt(fractions[i] * scaleX)},${fmt(yPx(v, range, plotHeight))}`);
    penDown = true;
  });
  return parts.join(' ');
}

// ---- Axis titles and the figure ----
export type FigureLayout = {
  yTitleBand: number;
  yTickBand: number;
  rightGutter: number;
  plotWidth: number;
  plotHeight: number;
  topSpace: number;
  xTickBand: number;
  xTitleBand: number;
  width: number;
  height: number;
  plot: Box;
  yTitle: Box;
  xTitle: Box;
};

const TITLE_FONT_PX = 11;
const TITLE_LINE = 16;
// Room right of the plot for the last point's marker (its ring included).
const RIGHT_GUTTER = MARKER_HALF + 2;

/**
 * The figure's bands at its floor width, in pixels: the y title column (text
 * turned 90°), the y tick column, the plot, the x tick row and the x title
 * row. A y title longer than the plot is tall makes the plot taller; an x
 * title wider than the plot wraps onto more rows. Both title boxes therefore
 * always lie inside the figure and never cross the plot or the ticks.
 */
export function figureLayout(input: {
  plotWidth: number;
  plotHeight: number;
  topSpace: number;
  yTickLabels: string[];
  yTitle: string;
  xTitle: string;
}): FigureLayout {
  const yTitleBand = TITLE_LINE + 4;
  const yTickBand = Math.max(0, ...input.yTickLabels.map((t) => estimateTextWidth(t))) + 8;
  const yTitleLength = estimateTextWidth(input.yTitle, TITLE_FONT_PX);
  const plotHeight = Math.max(input.plotHeight, yTitleLength);
  const plotWidth = input.plotWidth;
  const xTickBand = LABEL_BOX_HEIGHT + 8;
  const xTitleLines = Math.max(1, Math.ceil(estimateTextWidth(input.xTitle, TITLE_FONT_PX) / plotWidth));
  const xTitleBand = xTitleLines * TITLE_LINE + 4;
  const left = yTitleBand + yTickBand;
  const plot: Box = { x0: left, y0: input.topSpace, x1: left + plotWidth, y1: input.topSpace + plotHeight };
  const width = plot.x1 + RIGHT_GUTTER;
  const height = plot.y1 + xTickBand + xTitleBand;
  const midY = (plot.y0 + plot.y1) / 2;
  const yTitle: Box = { x0: 2, y0: midY - yTitleLength / 2, x1: 2 + TITLE_LINE, y1: midY + yTitleLength / 2 };
  const xTitle: Box = { x0: plot.x0, y0: plot.y1 + xTickBand, x1: plot.x1, y1: plot.y1 + xTickBand + xTitleLines * TITLE_LINE };
  return { yTitleBand, yTickBand, rightGutter: RIGHT_GUTTER, plotWidth, plotHeight, topSpace: input.topSpace, xTickBand, xTitleBand, width, height, plot, yTitle, xTitle };
}

// x tick labels that fit at the floor width without touching, at the given
// fractions (pointFractions for lines, slotFractions for bars): about as many
// as fit, always the first and last bucket. Returns the indices to label.
export function xTickIndices(labels: string[], fractions: number[], plotWidth: number): number[] {
  if (labels.length === 0) return [];
  const widest = Math.max(...labels.map((label) => estimateTextWidth(label)));
  const fit = Math.max(2, Math.floor(plotWidth / (widest + 12)));
  for (let target = Math.min(fit, labels.length); target >= 1; target -= 1) {
    const indices = labelIndices(labels.length, target);
    const boxes = indices.map((i) => clampSpan(fractions[i] * plotWidth, estimateTextWidth(labels[i]), 0, plotWidth));
    const clear = boxes.every((box, k) => k === 0 || box.x0 >= boxes[k - 1].x1 + 8);
    if (clear) return indices;
  }
  return [0];
}

// ---- Bars ----
// Bar thickness in pixels at the floor width: at most 24px, never the whole
// slot (a 4px gap per bar in a group), at least 4px.
export function barThickness(slotWidth: number, barsPerSlot = 1): number {
  return Math.max(4, Math.min(24, Math.floor((slotWidth - 4) / barsPerSlot) - 2));
}

// The floor width for a vertical bar chart.
export function minBarPlotWidth(slots: number, barsPerSlot = 1): number {
  return Math.min(640, Math.max(200, slots * (barsPerSlot * 14 + 10)));
}
