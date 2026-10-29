import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ADVERSARIAL_26, CONVERGING_3, WEEKS_26 } from './fixtures/fe4-series.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/chart-geometry');
const sourceFiles = [
  'src/lib/chart-geometry.ts',
  'src/lib/analytics-format.ts',
].map((relativePath) => resolve(root, relativePath));

for (const sourcePath of sourceFiles) {
  assert.equal(existsSync(sourcePath), true, `${sourcePath} should exist`);
}

mkdirSync(outDir, { recursive: true });

const program = ts.createProgram(sourceFiles, {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmitOnError: true,
  outDir,
});

const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  [],
  'chart modules should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data.replaceAll("'./types'", "'./types.mjs'"),
    );
  }
});

const geo = await import(pathToFileURL(resolve(outDir, 'chart-geometry.mjs')));

// ---- niceMax ----
assert.equal(geo.niceMax([]), 1, 'empty → 1');
assert.equal(geo.niceMax([0, 0, 0]), 1, 'all zero → 1 so a flat line still has an axis');
assert.equal(geo.niceMax([1]), 1);
assert.equal(geo.niceMax([3, 9, 6]), 10);
assert.equal(geo.niceMax([11]), 12);
assert.equal(geo.niceMax([137]), 150);
assert.equal(geo.niceMax([1362]), 1500);
assert.equal(geo.niceMax([2]), 2);

// ---- tickValues ----
assert.deepEqual(geo.tickValues(12), [0, 4, 8, 12]);
assert.deepEqual(geo.tickValues(10, 2), [0, 5, 10]);
assert.deepEqual(geo.tickValues(1), [0, 0.333, 0.667, 1]);

// ---- xPositions ----
assert.deepEqual(geo.xPositions(1, 100), [0], 'single bucket sits at the origin');
assert.deepEqual(geo.xPositions(3, 100), [0, 50, 100]);

// ---- linePath / areaPath / endPoint ----
assert.equal(geo.linePath([0, 5, 10], 100, 50, 10), 'M0.0,50.0 L50.0,25.0 L100.0,0.0');
assert.equal(geo.areaPath([0, 5, 10], 100, 50, 10), 'M0.0,50.0 L50.0,25.0 L100.0,0.0 L100,50 L0,50 Z');
assert.deepEqual(geo.endPoint([0, 5, 10], 100, 50, 10), { x: 100, y: 0 });
assert.equal(geo.linePath([4], 100, 50, 10), 'M0.0,30.0', 'a single point is a bare move');

// ---- columnPaths ----
const cols = geo.columnPaths([0, 2, 1], 90, 60, 2);
assert.equal(cols.length, 2, 'zero-value buckets draw nothing');
// slot = 30, thickness = min(24, 30-4) = 24, x for index 1 = 30 + 3 = 33
assert.match(cols[0], /^M33\.0,60 L33\.0,4\.0 Q33\.0,0\.0 37\.0,0\.0 L53\.0,0\.0 Q57\.0,0\.0 57\.0,4\.0 L57\.0,60 Z$/);
const wide = geo.columnPaths([1], 200, 40, 1);
assert.match(wide[0], /^M88\.0,40 /, 'thickness caps at 24px: (200-24)/2 = 88');
const thin = geo.columnPaths([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 60, 40, 1);
assert.match(thin[0], /Q2\.0,0\.0 3\.0,0\.0 /, 'radius shrinks to half the thickness when columns are narrow');

// ---- labelIndices ----
assert.deepEqual(geo.labelIndices(1), [0]);
assert.deepEqual(geo.labelIndices(2), [0, 1]);
assert.deepEqual(geo.labelIndices(7), [0, 2, 3, 5, 6]);
assert.deepEqual(geo.labelIndices(30), [0, 7, 15, 22, 29]);
assert.deepEqual(geo.labelIndices(13), [0, 3, 6, 9, 12]);

const fmtLib = await import(pathToFileURL(resolve(outDir, 'analytics-format.mjs')));

// ---- bucketLabel (moved from the page) ----
assert.equal(fmtLib.bucketLabel('2026-08-24T00:00:00.000Z', '30d'), 'Aug 24');
assert.equal(fmtLib.bucketLabel('2026-08-24T00:00:00.000Z', '90d'), 'Week of Aug 24');

// ---- sums / deltas ----
assert.equal(fmtLib.sum([3, 5, 2]), 10);
assert.equal(fmtLib.sum([]), 0);
assert.equal(fmtLib.formatCount(1362), '1,362');
assert.equal(fmtLib.signedDelta(149), '+149');
assert.equal(fmtLib.signedDelta(0), '0');
assert.equal(fmtLib.signedDelta(-3), '−3');

// ---- ratios ----
assert.equal(fmtLib.percentOf(6, 47), '13%');
assert.equal(fmtLib.percentOf(9, 700, 1), '1.3%');
assert.equal(fmtLib.percentOf(1, 0), null, 'no denominator → null, caller omits the text');
assert.equal(fmtLib.perUnit(137, 14), '9.8');
assert.equal(fmtLib.perUnit(5, 0), null);

// ---- period end label ----
const base = {
  employerId: 'e', displayName: 'X', planCode: 'starter', status: 'active', cancelAtPeriodEnd: false,
  organizationId: 'o', membersActive: 1, seatsUsed: 0, seatsPending: 0, seatsSuspended: 0, seatLimit: null,
};
assert.equal(fmtLib.periodEndLabel({ ...base, currentPeriodEnd: '2026-09-21T00:00:00.000Z' }), 'Renews Sep 21');
assert.equal(fmtLib.periodEndLabel({ ...base, status: 'trialing', currentPeriodEnd: '2026-09-09T00:00:00.000Z' }), 'Trial ends Sep 9');
assert.equal(fmtLib.periodEndLabel({ ...base, status: 'past_due', currentPeriodEnd: '2026-09-01T00:00:00.000Z' }), 'Due Sep 1');
assert.equal(fmtLib.periodEndLabel({ ...base, cancelAtPeriodEnd: true, currentPeriodEnd: '2026-09-30T00:00:00.000Z' }), 'Cancels Sep 30');
assert.equal(fmtLib.periodEndLabel(base), '—');

// ---- cumulativeSeries ----
assert.deepEqual(fmtLib.cumulativeSeries([1, 0, 2], 10), [8, 8, 10], 'baseline = total − window sum; the last point is the total');
assert.deepEqual(fmtLib.cumulativeSeries([0, 0, 0], 5), [5, 5, 5], 'no signups → flat at the total, never zero');
assert.deepEqual(fmtLib.cumulativeSeries([3, 4], 5), [3, 7], 'baseline clamps at 0 if the window outgrows the total');
assert.deepEqual(fmtLib.cumulativeSeries([], 4), [], 'no buckets → no points');

// 2a: end labels of lines that finish close together are spread apart,
// never reordered, and never pushed below the zero baseline.
assert.deepEqual(geo.spreadLabels([100, 104, 200], 14, 244), [100, 114, 200]);
assert.deepEqual(geo.spreadLabels([200, 104, 100], 14, 244), [200, 114, 100]);
assert.deepEqual(geo.spreadLabels([244, 244, 244], 14, 244), [216, 230, 244], 'flat zero lines stack upward');

// 2b: a null value is a gap (a week with no median), never a zero. The pen
// lifts over it; a point with no neighbour gets a dot instead of a line.
assert.equal(geo.linePath([1, null, 3], 100, 30, 3), 'M0.0,20.0 M100.0,0.0', 'a null lifts the pen');
assert.equal(
  geo.linePath([null, 2, 4, null, 3, 3], 500, 40, 4),
  'M100.0,20.0 L200.0,0.0 M400.0,10.0 L500.0,10.0',
  'a leading null is skipped and every run after a gap starts with a move',
);
assert.equal(geo.linePath([2, 4, null, null], 300, 40, 4), 'M0.0,20.0 L100.0,0.0', 'trailing nulls draw nothing');
assert.equal(geo.linePath([null, null], 100, 40, 4), '', 'all null: no path at all');
assert.equal(geo.niceMax([null, 7, null]), 8, 'nulls are ignored when sizing the axis');
assert.equal(geo.niceMax([null]), 1);
assert.deepEqual(geo.isolatedPoints([2, null, 3, 4], 300, 40, 4), [{ x: 0, y: 20 }], 'a lone point gets a dot');
assert.deepEqual(geo.isolatedPoints([null, 2, null, 4], 300, 40, 4), [{ x: 100, y: 20 }], 'the last point is left to the end dot');
assert.deepEqual(geo.isolatedPoints([1, null], 100, 40, 4), [{ x: 0, y: 30 }]);
assert.deepEqual(geo.isolatedPoints([1, 2, 3], 200, 40, 4), [], 'a connected line has no lone points');

// 2b: round tick steps. The first interval count (3, 4, 5, 6 by default)
// whose step is 1, 2 or 5 times a power of ten: no 26.667 on an 80 h axis.
for (const [max, intervals] of [
  [1, 5], [1.2, 6], [1.5, 3], [2, 4], [2.5, 5], [3, 3], [4, 4], [5, 5], [6, 3], [8, 4], [10, 5],
  [12, 6], [30, 3], [80, 4], [100, 5], [150, 3], [1500, 3],
]) {
  assert.equal(geo.tickIntervals(max), intervals, `tickIntervals(${max})`);
}
assert.deepEqual(geo.tickValues(80, geo.tickIntervals(80)), [0, 20, 40, 60, 80]);
assert.deepEqual(geo.tickValues(1.2, geo.tickIntervals(1.2)), [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2]);
assert.equal(geo.tickIntervals(10, [2, 3, 4, 5]), 2, 'the column chart prefers fewer lines: 0 / 5 / 10');
assert.equal(geo.tickIntervals(2.5, [2, 3, 4, 5]), 5);
assert.equal(geo.tickIntervals(1.2, [2, 3, 4, 5]), 2, 'no round step: the first choice');

// ==== S28 FE-4 (D11): value labels, ticks with units, axis titles ====
// ---- D11 (S28): value labels never overlap ----
assert.equal(geo.estimateTextWidth('1,240'), Math.ceil((4 * 0.7 + 0.4) * 11), 'digits 0.7em, comma 0.4em, rounded up');
assert.equal(geo.boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 0, x1: 20, y1: 10 }), false, 'touching is not overlapping');
assert.equal(geo.boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 9, y0: 9, x1: 20, y1: 20 }), true);
assert.equal(geo.boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 }, 2), true, 'closer than pad overlaps');
assert.deepEqual(geo.clampSpan(5, 20, 0, 100), { x0: 0, x1: 20 }, 'a label at the left edge shifts right');
assert.deepEqual(geo.clampSpan(98, 20, 0, 100), { x0: 80, x1: 100 }, 'a label at the right edge shifts left');
assert.deepEqual(geo.pointFractions(1), [0.5]);
assert.deepEqual(geo.pointFractions(3), [0, 0.5, 1]);
assert.deepEqual(geo.slotFractions(2), [0.25, 0.75]);
assert.deepEqual(geo.hollowFlags(3, true), [false, false, true]);
assert.deepEqual(geo.hollowFlags(3, false), [false, false, false]);
assert.deepEqual(geo.hollowFlags(0, true), []);
assert.equal(geo.minPlotWidth(8), 200);
assert.equal(geo.minPlotWidth(26), 416);
assert.equal(geo.minPlotWidth(26, 3), 640);

const PLOT_H = 220;
// Lays out one chart's labels exactly as LineChart does, and returns what a
// check needs: the placement, the markers, the floor width.
function layoutLines(seriesList, { unit = '' } = {}) {
  const count = seriesList[0].length;
  const range = geo.axisRange(seriesList.flat());
  const width = geo.minPlotWidth(count, seriesList.length);
  const fractions = geo.pointFractions(count);
  const sides = seriesList.map((values) => geo.preferredSides(values.map((v) => (v === null ? null : geo.yPx(v, range, PLOT_H)))));
  const points = [];
  const markers = [];
  for (let i = 0; i < count; i += 1) {
    seriesList.forEach((values, s) => {
      const v = values[i];
      if (v === null) return;
      const x = fractions[i] * width;
      const y = geo.yPx(v, range, PLOT_H);
      points.push({ x, y, text: geo.formatTick(v, unit), above: sides[s][i], f: fractions[i] });
      markers.push({ x0: x - geo.MARKER_HALF, y0: y - geo.MARKER_HALF, x1: x + geo.MARKER_HALF, y1: y + geo.MARKER_HALF, f: fractions[i] });
    });
  }
  const area = { x0: 0, y0: -(geo.LABEL_BOX_HEIGHT + 8), x1: width, y1: PLOT_H };
  const placement = geo.placeValueLabels(points, area, { obstacles: markers });
  return { placement, points, markers, width, area };
}

// At `scale` times the floor width: every box keeps its pixel offset from its
// point, and points move with the plot.
function boxesAt(placement, points, width, scale) {
  return placement.labels.map((label, k) => {
    const offset = label.x - label.box.x0;
    const x0 = points[k].f * width * scale - offset;
    return { ...label.box, x0, x1: x0 + (label.box.x1 - label.box.x0) };
  });
}
function markersAt(markers, width, scale) {
  return markers.map((m) => ({ ...m, x0: m.f * width * scale - geo.MARKER_HALF, x1: m.f * width * scale + geo.MARKER_HALF }));
}

function assertClear(name, seriesList, options) {
  const { placement, points, markers, width, area } = layoutLines(seriesList, options);
  const expected = seriesList.flat().filter((v) => v !== null).length;
  assert.equal(placement.labels.filter(Boolean).length, expected, `${name}: every point has a value label`);
  for (const scale of [1, 1.5, 3]) {
    const boxes = boxesAt(placement, points, width, scale);
    const marks = markersAt(markers, width, scale);
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        assert.equal(geo.boxesOverlap(boxes[a], boxes[b]), false, `${name} ×${scale}: labels ${a} and ${b} overlap`);
      }
      for (const m of marks) {
        assert.equal(geo.boxesOverlap(boxes[a], m), false, `${name} ×${scale}: label ${a} covers a marker`);
      }
    }
  }
  for (const label of placement.labels) {
    assert.ok(label.box.x0 >= area.x0 && label.box.x1 <= area.x1, `${name}: label "${label.text}" stays inside the plot width`);
    assert.ok(label.box.y1 <= area.y1, `${name}: label "${label.text}" never drops below the x axis`);
  }
  assert.deepEqual(layoutLines(seriesList, options).placement, placement, `${name}: the same input gives the same layout`);
  return placement;
}

for (const [name, values] of Object.entries(ADVERSARIAL_26)) assertClear(name, [values]);
assertClear('converging three', CONVERGING_3);
assertClear('rates', [ADVERSARIAL_26.ramp.map((v) => v * 3.7), ADVERSARIAL_26.sawtooth.map((v) => v / 10000)], { unit: '%' });

// Peaks prefer the row above, valleys the row below.
assert.deepEqual(geo.preferredSides([10, 0, 10]), [false, true, false], 'screen y: 0 is the top, so 0 is the peak');
assert.deepEqual(geo.preferredSides([null, 5]), [true, true]);

// Bars: labels only above, never inside a bar.
{
  const values = ADVERSARIAL_26.spikes;
  const range = geo.axisRange(values);
  const width = geo.minBarPlotWidth(values.length);
  const slot = width / values.length;
  const t = geo.barThickness(slot);
  const fr = geo.slotFractions(values.length);
  const bars = values.map((v, i) => ({ x0: fr[i] * width - t / 2, x1: fr[i] * width + t / 2, y0: geo.yPx(v, range, PLOT_H), y1: PLOT_H }));
  const points = values.map((v, i) => ({ x: fr[i] * width, y: geo.yPx(v, range, PLOT_H), text: geo.formatTick(v) }));
  const area = { x0: 0, y0: -(geo.LABEL_BOX_HEIGHT + 8), x1: width, y1: PLOT_H };
  const placement = geo.placeValueLabels(points, area, { sides: 'above', obstacles: bars, gap: 4 });
  for (let a = 0; a < placement.labels.length; a += 1) {
    const box = placement.labels[a].box;
    assert.ok(box.y1 <= points[a].y - 4, `bar ${a}: the label sits above its bar`);
    for (let b = a + 1; b < placement.labels.length; b += 1) assert.equal(geo.boxesOverlap(box, placement.labels[b].box), false, `bars ${a}/${b}`);
    for (const bar of bars) assert.equal(geo.boxesOverlap(box, bar), false, `bar label ${a} covers a bar`);
  }
}

// ---- ticks with units ----
assert.equal(geo.formatTick(80, '%'), '80%');
assert.equal(geo.formatTick(1500), '1,500');
assert.equal(geo.formatTick(2.5, 'h'), '2.5h');
assert.equal(geo.formatTick(0, '%'), '0%');
assert.equal(geo.formatTick(1234, '', (v) => `${(v / 1000).toFixed(1)}k`), '1.2k');
assert.deepEqual(geo.axisRange([]), { min: 0, max: 1, ticks: [0, 1] }, 'no data: a 0–1 count axis');
assert.deepEqual(geo.axisRange([null, null]), { min: 0, max: 1, ticks: [0, 1] });
assert.deepEqual(geo.axisRange([3, 1]), { min: 0, max: 3, ticks: [0, 1, 2, 3] }, 'small counts tick by one');
assert.deepEqual(geo.axisRange([7]), { min: 0, max: 8, ticks: [0, 2, 4, 6, 8] });
assert.deepEqual(geo.axisRange([137]), { min: 0, max: 150, ticks: [0, 50, 100, 150] });
assert.deepEqual(geo.axisRange([0.4, 0.9]), { min: 0, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }, 'fractions keep fine ticks');
assert.deepEqual(geo.axisRange([93, 97.5, 98], 80), { min: 80, max: 100, ticks: [80, 85, 90, 95, 100] }, '#10: the axis starts at 80');
assert.deepEqual(geo.axisRange([93, 79, 98], 80), { min: 0, max: 100, ticks: [0, 20, 40, 60, 80, 100] }, 'a value below 80 puts the floor back at 0');
assert.equal(geo.yPx(0, { min: 0, max: 10, ticks: [] }, 200), 200);
assert.equal(geo.yPx(10, { min: 0, max: 10, ticks: [] }, 200), 0);
assert.equal(geo.yPx(90, { min: 80, max: 100, ticks: [] }, 200), 100);
assert.equal(geo.scaledLinePath([0, null, 10, 5], geo.pointFractions(4), { min: 0, max: 10, ticks: [] }, 100), 'M0.0,100.0 M666.7,0.0 L1000.0,50.0');
assert.equal(geo.scaledLinePath([null], [0.5], { min: 0, max: 1, ticks: [] }, 100), '');

// ---- axis titles inside the figure ----
function inside(inner, outer) {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}
for (const [yTitle, xTitle, plotWidth] of [
  ['Total signups', 'Week starting', 416],
  ['Share of workers who started onboarding that week and finished every step (%)', 'Week starting', 200],
  ['Signups', 'Share of workers who started verification (%) · count, by the week they started', 200],
]) {
  const layout = geo.figureLayout({ plotWidth, plotHeight: 160, topSpace: 22, yTickLabels: ['0', '1,500', '3,000'], yTitle, xTitle });
  const figure = { x0: 0, y0: 0, x1: layout.width, y1: layout.height };
  assert.ok(inside(layout.yTitle, figure), `y title "${yTitle}" inside the figure`);
  assert.ok(inside(layout.xTitle, figure), `x title "${xTitle}" inside the figure`);
  assert.ok(inside(layout.plot, figure));
  assert.equal(geo.boxesOverlap(layout.yTitle, layout.plot), false, 'the y title never crosses the plot');
  assert.equal(geo.boxesOverlap(layout.xTitle, layout.plot), false, 'the x title never crosses the plot');
  assert.ok(layout.yTitle.x1 <= layout.yTitleBand, 'the y title stays in its column, left of the ticks');
  assert.ok(layout.xTitle.y0 >= layout.plot.y1 + layout.xTickBand, 'the x title sits below the tick row');
}

// ---- x ticks fit without touching ----
const weekLabels = WEEKS_26.map((iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
for (const width of [200, 416]) {
  const idx = geo.xTickIndices(weekLabels, geo.pointFractions(26), width);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 25);
}
assert.deepEqual(geo.xTickIndices(['A'], [0.5], 200), [0]);
assert.deepEqual(geo.xTickIndices([], [], 200), []);
// D11 format helpers (analytics-format.ts).
assert.equal(fmtLib.weekLabel('2026-10-12T00:00:00.000Z'), 'Oct 12', 'a week is labelled by its Monday');
assert.equal(fmtLib.wholePercent(1, 1000), '<1%', 'some is never 0%');
assert.equal(fmtLib.wholePercent(999, 1000), '>99%', 'almost all is never 100%');
assert.equal(fmtLib.wholePercent(0, 10), '0%');
assert.equal(fmtLib.wholePercent(10, 10), '100%');
assert.equal(fmtLib.wholePercent(5, 0), '—', 'nothing to divide by');
assert.equal(fmtLib.shareRate(1, 3), 33.3);
assert.equal(fmtLib.shareRate(1, 10000), 0.1, 'some is never 0');
assert.equal(fmtLib.shareRate(9999, 10000), 99.9, 'almost all is never 100');
assert.equal(fmtLib.shareRate(0, 5), 0);
assert.equal(fmtLib.shareRate(3, 3), 100);
assert.equal(fmtLib.shareRate(1, 0), null, 'nothing to divide by: a gap');
assert.equal(fmtLib.formatRate(12), '12');
assert.equal(fmtLib.formatRate(12.5), '12.5');
assert.equal(fmtLib.formatRate(1234.5), '1,234.5');
assert.equal(fmtLib.funnelLabel(940, 1000), '94% · 940');
assert.equal(fmtLib.funnelLabel(1240, 1240), '100% · 1,240');
assert.equal(fmtLib.funnelLabel(0, 0), '— · 0', 'no base: a dash, never NaN%');
assert.deepEqual(
  fmtLib.oldestFirst([{ weekStart: '2026-10-12T00:00:00.000Z' }, { weekStart: '2026-10-05T00:00:00.000Z' }]).map((w) => w.weekStart),
  ['2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'],
);
assert.deepEqual(
  fmtLib.weeklyAxis([{ weekStart: '2026-10-05T00:00:00.000Z', partial: false }, { weekStart: '2026-10-12T00:00:00.000Z', partial: true }]),
  { labels: ['Oct 5', 'Oct 12'], partialLast: true },
);
assert.deepEqual(fmtLib.weeklyAxis([]), { labels: [], partialLast: false });
assert.equal(fmtLib.ANALYTICS_RELEASE_LABEL.length > 0, true, 'the release label is set (jale sets the date at release)');
// ==== end S28 FE-4 ====
console.log('check-chart-geometry: all assertions passed');
