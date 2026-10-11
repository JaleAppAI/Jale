/**
 * Pure SVG geometry for the analytics charts. No React, no DOM: every function
 * maps numbers to path strings or coordinates so the check script can pin the
 * exact output. Sizes are the SVG plot area (width × height); `max` is the
 * axis maximum from `niceMax`.
 */

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const fmt = (n: number): string => n.toFixed(1);

export function niceMax(values: number[]): number {
  const max = values.reduce((acc, v) => (v > acc ? v : acc), 0);
  if (max <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of NICE_STEPS) {
    const candidate = step * magnitude;
    if (candidate >= max) return Number(candidate.toPrecision(12));
  }
  return 10 * magnitude;
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

export function linePath(values: number[], width: number, height: number, max: number): string {
  const xs = xPositions(values.length, width);
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${fmt(xs[i])},${fmt(yFor(v, height, max))}`)
    .join(' ');
}

export function areaPath(values: number[], width: number, height: number, max: number): string {
  return `${linePath(values, width, height, max)} L${width},${height} L0,${height} Z`;
}

export function endPoint(values: number[], width: number, height: number, max: number): { x: number; y: number } {
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
