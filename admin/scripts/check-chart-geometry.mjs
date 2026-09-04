import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

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
const base = { employerId: 'e', displayName: 'X', planCode: 'starter', status: 'active', cancelAtPeriodEnd: false };
assert.equal(fmtLib.periodEndLabel({ ...base, currentPeriodEnd: '2026-09-21T00:00:00.000Z' }), 'Renews Sep 21');
assert.equal(fmtLib.periodEndLabel({ ...base, status: 'trialing', currentPeriodEnd: '2026-09-09T00:00:00.000Z' }), 'Trial ends Sep 9');
assert.equal(fmtLib.periodEndLabel({ ...base, status: 'past_due', currentPeriodEnd: '2026-09-01T00:00:00.000Z' }), 'Due Sep 1');
assert.equal(fmtLib.periodEndLabel({ ...base, cancelAtPeriodEnd: true, currentPeriodEnd: '2026-09-30T00:00:00.000Z' }), 'Cancels Sep 30');
assert.equal(fmtLib.periodEndLabel(base), '—');

console.log('check-chart-geometry: all assertions passed');
