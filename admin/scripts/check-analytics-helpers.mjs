import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/analytics-helpers');
const sourceFiles = [
  'src/lib/server/db-secret.ts',
  'src/lib/server/db.ts',
  'src/lib/server/admin-analytics.ts',
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
  'admin analytics module should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data
        .replaceAll("'./db-secret'", "'./db-secret.mjs'")
        .replaceAll("'./db'", "'./db.mjs'")
        .replaceAll("'../types'", "'./types.mjs'"),
    );
  }
});

const analytics = await import(pathToFileURL(resolve(outDir, 'admin-analytics.mjs')));

// ---- parseAnalyticsRange ----
assert.equal(analytics.parseAnalyticsRange('7d'), '7d');
assert.equal(analytics.parseAnalyticsRange('30d'), '30d');
assert.equal(analytics.parseAnalyticsRange('90d'), '90d');
assert.equal(analytics.parseAnalyticsRange('junk'), '30d', 'unknown range falls back to 30d');
assert.equal(analytics.parseAnalyticsRange(undefined), '30d', 'missing range falls back to 30d');
assert.equal(analytics.parseAnalyticsRange(['7d']), '30d', 'array (repeated param) falls back to 30d');

// ---- resolveRange ----
// Fixed "now" so assertions are deterministic: Sunday 2026-08-30 15:00 UTC.
const now = new Date('2026-08-30T15:00:00.000Z');

const seven = analytics.resolveRange('7d', now);
assert.equal(seven.bucket, 'day');
assert.equal(seven.from.toISOString(), '2026-08-24T00:00:00.000Z', '7d starts 6 days back, day-truncated');

const thirty = analytics.resolveRange('30d', now);
assert.equal(thirty.bucket, 'day');
assert.equal(thirty.from.toISOString(), '2026-08-01T00:00:00.000Z', '30d starts 29 days back, day-truncated');

const ninety = analytics.resolveRange('90d', now);
assert.equal(ninety.bucket, 'week');
// 89 days before now is Tue 2026-06-02; its ISO week starts Mon 2026-06-01.
assert.equal(ninety.from.toISOString(), '2026-06-01T00:00:00.000Z', '90d starts at ISO-week boundary');
assert.equal(ninety.from.getUTCDay(), 1, 'weekly buckets start on Monday');

// ---- bucketStarts ----
const dayStarts = analytics.bucketStarts(seven.from, 'day', now);
assert.equal(dayStarts.length, 7);
assert.equal(dayStarts[0], '2026-08-24T00:00:00.000Z');
assert.equal(dayStarts[6], '2026-08-30T00:00:00.000Z');

const weekStarts = analytics.bucketStarts(ninety.from, 'week', now);
assert.equal(weekStarts[0], '2026-06-01T00:00:00.000Z');
assert.equal(weekStarts[weekStarts.length - 1], '2026-08-24T00:00:00.000Z', 'last bucket is the ISO week containing now');
assert.equal(weekStarts.length, 13);

// ---- fillBuckets ----
const filled = analytics.fillBuckets(
  [{ bucketStart: '2026-08-25T00:00:00.000Z', workerSignups: 3, employerSignups: 1 }],
  dayStarts,
  (bucketStart) => ({ bucketStart, workerSignups: 0, employerSignups: 0 }),
);
assert.equal(filled.length, 7, 'every bucket present after gap filling');
assert.deepEqual(filled[1], { bucketStart: '2026-08-25T00:00:00.000Z', workerSignups: 3, employerSignups: 1 });
assert.deepEqual(filled[0], { bucketStart: '2026-08-24T00:00:00.000Z', workerSignups: 0, employerSignups: 0 });

// ---- row mappers (pg returns BIGINT as string, TIMESTAMPTZ as Date) ----
assert.deepEqual(
  analytics.mapTotalsRow({
    total_workers: '12', total_employers: '5', paying_employers: '3',
    jobs_active: '7', jobs_paused: '1', jobs_filled: '2', jobs_closed: '4',
  }),
  { totalWorkers: 12, totalEmployers: 5, payingEmployers: 3, jobsActive: 7, jobsPaused: 1, jobsFilled: 2, jobsClosed: 4 },
);

assert.deepEqual(
  analytics.mapSignupRow({ bucket_start: new Date('2026-08-25T00:00:00.000Z'), worker_signups: '3', employer_signups: '1' }),
  { bucketStart: '2026-08-25T00:00:00.000Z', workerSignups: 3, employerSignups: 1 },
);

assert.deepEqual(
  analytics.mapJobsActivityRow({ bucket_start: new Date('2026-08-25T00:00:00.000Z'), jobs_posted: '2', applications_submitted: '9' }),
  { bucketStart: '2026-08-25T00:00:00.000Z', jobsPosted: 2, applicationsSubmitted: 9 },
);

assert.deepEqual(
  analytics.mapMessageTrafficRow({
    bucket_start: new Date('2026-08-25T00:00:00.000Z'),
    job_messages_out: '4', job_messages_in: '2', job_messages_failed: '1',
    wa_inbound: '10', wa_outbound: '8', wa_failed: '0',
  }),
  { bucketStart: '2026-08-25T00:00:00.000Z', jobMessagesOut: 4, jobMessagesIn: 2, jobMessagesFailed: 1, waInbound: 10, waOutbound: 8, waFailed: 0 },
);

assert.deepEqual(
  analytics.mapPayingEmployerRow({
    employer_id: '00000000-0000-0000-0000-000000000001',
    display_name: 'IT Analytics Co', plan_code: 'pro_monthly', status: 'active',
    current_period_end: new Date('2026-09-15T00:00:00.000Z'), cancel_at_period_end: false,
  }),
  {
    employerId: '00000000-0000-0000-0000-000000000001', displayName: 'IT Analytics Co',
    planCode: 'pro_monthly', status: 'active',
    currentPeriodEnd: '2026-09-15T00:00:00.000Z', cancelAtPeriodEnd: false,
  },
);
assert.equal(
  analytics.mapPayingEmployerRow({
    employer_id: '00000000-0000-0000-0000-000000000002',
    display_name: 'Empleador', plan_code: 'pro_monthly', status: 'trialing',
    current_period_end: null, cancel_at_period_end: true,
  }).currentPeriodEnd,
  undefined,
  'null period end maps to undefined',
);

console.log('check-analytics-helpers: all assertions passed');
