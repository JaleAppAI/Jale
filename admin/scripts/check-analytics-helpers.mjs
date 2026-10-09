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
  'src/lib/analytics-format.ts',
  'src/lib/funnel.ts',
  'src/lib/employer-health.ts',
  'src/lib/ops-health.ts',
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
        .replaceAll("'./analytics-format'", "'./analytics-format.mjs'")
        .replaceAll("'../ops-health'", "'./ops-health.mjs'")
        .replaceAll("'../types'", "'./types.mjs'"),
    );
  }
});

const analytics = await import(pathToFileURL(resolve(outDir, 'admin-analytics.mjs')));
const funnel = await import(pathToFileURL(resolve(outDir, 'funnel.mjs')));
const health = await import(pathToFileURL(resolve(outDir, 'employer-health.mjs')));
const ops = await import(pathToFileURL(resolve(outDir, 'ops-health.mjs')));

// ---- parseAnalyticsRange ----
assert.equal(analytics.parseAnalyticsRange('7d'), '7d');
assert.equal(analytics.parseAnalyticsRange('30d'), '30d');
assert.equal(analytics.parseAnalyticsRange('90d'), '90d');
assert.equal(analytics.parseAnalyticsRange('junk'), '30d', 'unknown range falls back to 30d');
assert.equal(analytics.parseAnalyticsRange(undefined), '30d', 'missing range falls back to 30d');
assert.equal(analytics.parseAnalyticsRange(['7d']), '30d', 'array (repeated param) falls back to 30d');

// ---- parseSignupsView ----
assert.equal(analytics.parseSignupsView('new'), 'new');
assert.equal(analytics.parseSignupsView('total'), 'total');
assert.equal(analytics.parseSignupsView(undefined), 'total', 'missing view defaults to the running total');
assert.equal(analytics.parseSignupsView('junk'), 'total', 'unknown view falls back to total');
assert.equal(analytics.parseSignupsView(['new']), 'total', 'array (repeated param) falls back to total');

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
    hires_total: '9', jobs_with_hire: '6', total_verified_workers: '10',
  }),
  {
    totalWorkers: 12, totalEmployers: 5, payingEmployers: 3,
    jobsActive: 7, jobsPaused: 1, jobsFilled: 2, jobsClosed: 4,
    hiresTotal: 9, jobsWithHire: 6, totalVerifiedWorkers: 10,
  },
);

assert.deepEqual(
  analytics.mapSignupRow({
    bucket_start: new Date('2026-08-25T00:00:00.000Z'),
    worker_signups: '3', employer_signups: '1', worker_signups_verified: '2',
  }),
  { bucketStart: '2026-08-25T00:00:00.000Z', workerSignups: 3, employerSignups: 1, workerSignupsVerified: 2 },
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

// ---- 2a: onboarding funnel ----
assert.equal(analytics.parseFunnelWeeks('4'), 4);
assert.equal(analytics.parseFunnelWeeks('12'), 12);
assert.equal(analytics.parseFunnelWeeks('8'), 8);
assert.equal(analytics.parseFunnelWeeks('26'), 8, 'only 4/8/12 are offered');
assert.equal(analytics.parseFunnelWeeks(undefined), 8);
assert.equal(analytics.parseFunnelWeeks(['4']), 8, 'array (repeated param) falls back');
assert.equal(analytics.parseFunnelDoor('whatsapp'), 'whatsapp');
assert.equal(analytics.parseFunnelDoor('web'), 'web');
assert.equal(analytics.parseFunnelDoor('junk'), 'all');
assert.equal(analytics.parseFunnelDoor(undefined), 'all');
assert.equal(analytics.FUNNEL_STALLED_DAYS, 7);
assert.equal(
  analytics.mapSignupRow({ bucket_start: new Date('2026-08-25T00:00:00.000Z'), worker_signups: '3', employer_signups: '1' }).workerSignupsVerified,
  0,
  'a database without migration 113 maps to 0 verified, never NaN',
);
assert.equal(
  analytics.mapTotalsRow({
    total_workers: '1', total_employers: '1', paying_employers: '0', jobs_active: '0', jobs_paused: '0',
    jobs_filled: '0', jobs_closed: '0', hires_total: '0', jobs_with_hire: '0',
  }).totalVerifiedWorkers,
  0,
);

const cohortRow = {
  cohort_week: new Date('2026-09-28T00:00:00.000Z'), door: 'whatsapp',
  started: '10', code_requested: '8', verified: '6', accepted_terms: '5',
  finished_profile: '4', ready: '3', declined: '1', in_progress: '2', abandoned: '4',
};
assert.deepEqual(analytics.mapOnboardingCohortRow(cohortRow), {
  cohortWeek: '2026-09-28T00:00:00.000Z', door: 'whatsapp',
  started: 10, codeRequested: 8, verified: 6, acceptedTerms: 5,
  finishedProfile: 4, ready: 3, declined: 1, inProgress: 2, abandoned: 4,
});
assert.throws(() => analytics.mapOnboardingCohortRow({ ...cohortRow, door: 'sms' }), /Unexpected funnel door/);
assert.deepEqual(
  analytics.mapOnboardingStalledRow({ door: 'web', step_key: 'profile.location', workers: '3' }),
  { door: 'web', stepKey: 'profile.location', workers: 3 },
);
assert.equal(analytics.mapOnboardingStalledRow({ door: 'mystery', step_key: 'legal.review', workers: 1 }).door, 'other');
assert.equal(typeof analytics.getOnboardingCohorts, 'function');
assert.equal(typeof analytics.getOnboardingStalled, 'function');

// Weeks: Monday 00:00 UTC, oldest first, ending with the current week.
const weekNow = new Date('2026-10-08T15:00:00.000Z'); // a Thursday
assert.deepEqual(funnel.cohortWeekStarts(4, weekNow), [
  '2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z',
  '2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z',
]);
assert.equal(funnel.cohortWeekStarts(12, weekNow).length, 12);

const zeroCounts = { started: 0, codeRequested: 0, verified: 0, acceptedTerms: 0, finishedProfile: 0, ready: 0, declined: 0, inProgress: 0, abandoned: 0 };
const wa = { ...zeroCounts, cohortWeek: '2026-09-28T00:00:00.000Z', door: 'whatsapp', started: 10, codeRequested: 8, verified: 6, acceptedTerms: 5, finishedProfile: 4, ready: 3, declined: 1, inProgress: 2, abandoned: 4 };
const web = { ...zeroCounts, cohortWeek: '2026-09-28T00:00:00.000Z', door: 'web', started: 5, codeRequested: 5, verified: 2, acceptedTerms: 2, finishedProfile: 1, ready: 1, inProgress: 1, abandoned: 3 };
const funnelWeeks = ['2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z']; // `weekStarts` is already declared above

const all = funnel.cohortsForDoor([wa, web], 'all', funnelWeeks);
assert.deepEqual(all[0], { cohortWeek: '2026-09-21T00:00:00.000Z', ...zeroCounts }, 'an empty week is zero-filled');
assert.equal(all[1].started, 15);
assert.equal(all[1].ready, 4);
assert.equal(funnel.cohortsForDoor([wa, web], 'web', funnelWeeks)[1].started, 5);
assert.equal(funnel.cohortsForDoor([wa, web], 'whatsapp', funnelWeeks)[1].codeRequested, 8);

const total = funnel.totalCounts(all);
assert.equal(total.started, 15);
assert.equal(total.abandoned, 7);

const allStages = funnel.funnelStages(total, 'all');
assert.deepEqual(allStages.map((s) => s.label), ['Started', 'Verified', 'Accepted terms', 'Finished profile', 'Ready']);
assert.deepEqual(allStages[0], { key: 'started', label: 'Started', count: 15, ofStarted: null, ofPrevious: null });
assert.deepEqual(allStages[1], { key: 'verified', label: 'Verified', count: 8, ofStarted: '53%', ofPrevious: '53%' });
assert.equal(allStages[4].ofPrevious, '80%', 'ready over finished profile: 4 of 5');
const waStages = funnel.funnelStages(funnel.totalCounts(funnel.cohortsForDoor([wa], 'whatsapp', funnelWeeks)), 'whatsapp');
assert.deepEqual(waStages.map((s) => s.label), ['Started', 'Requested a code', 'Verified', 'Accepted terms', 'Finished profile', 'Ready']);
assert.equal(waStages[2].ofPrevious, '75%', 'verified over requested a code: 6 of 8');
assert.equal(funnel.funnelStages({ ...zeroCounts }, 'all')[1].ofStarted, null, 'no starters, no rate');

assert.equal(funnel.isSettling('2026-09-28T00:00:00.000Z', weekNow), true, 'last week ended 3 days ago');
assert.equal(funnel.isSettling('2026-09-21T00:00:00.000Z', weekNow), false, 'ended 10 days ago');
assert.equal(funnel.isSettling('2026-10-05T00:00:00.000Z', weekNow), true, 'the current week');

assert.equal(funnel.stepLabel('legal.review'), 'Terms');
assert.equal(funnel.stepLabel('trust.question.2'), 'Trust question 2');
assert.equal(funnel.stepLabel('profile.custom_trade'), 'Custom trade');
assert.equal(funnel.stepLabel('something.new'), 'something.new', 'unknown steps show their key');

const stalledRows = [
  { door: 'web', stepKey: 'profile.location', workers: 3 },
  { door: 'whatsapp', stepKey: 'profile.location', workers: 2 },
  { door: 'whatsapp', stepKey: 'legal.review', workers: 5 },
  { door: 'other', stepKey: 'profile.name', workers: 1 },
];
assert.deepEqual(funnel.stalledForDoor(stalledRows, 'all'), [
  { stepKey: 'legal.review', label: 'Terms', workers: 5 },
  { stepKey: 'profile.location', label: 'Location', workers: 5 },
  { stepKey: 'profile.name', label: 'Name', workers: 1 },
], 'ties keep the onboarding order');
assert.deepEqual(funnel.stalledForDoor(stalledRows, 'web'), [{ stepKey: 'profile.location', label: 'Location', workers: 3 }]);

assert.equal(funnel.shareShade(0, 0), undefined);
assert.equal(funnel.shareShade(0, 10), 'rgba(1, 121, 255, 0.06)');
assert.equal(funnel.shareShade(10, 10), 'rgba(1, 121, 255, 0.36)');
assert.equal(funnel.funnelsHref(8, 'all'), '/analytics/funnels?weeks=8');
assert.equal(funnel.funnelsHref(4, 'web'), '/analytics/funnels?weeks=4&door=web');

// ---- 2b: employer health ----
assert.equal(analytics.STALE_JOB_DAYS, 14);
assert.equal(analytics.SLOWEST_EMPLOYERS_LIMIT, 10);
assert.equal(typeof analytics.getEmployerWeekly, 'function');
assert.equal(typeof analytics.getSlowestEmployers, 'function');
assert.equal(typeof analytics.getStaleJobs, 'function');

// pg returns BIGINT and NUMERIC as strings, INTEGER as a number, TIMESTAMPTZ as
// a Date; SQL NULL must stay null (never 0, never NaN).
const employerWeekRow = {
  week_start: new Date('2026-09-28T00:00:00.000Z'),
  applications: '12', answered: '9', answered_untimed: '1', unanswered_7d: '2', applications_due: '10',
  first_response_p50_hours: '5.2', first_response_p75_hours: '74.4',
  worker_turns: '7', turns_unanswered_7d: '1', turns_due: '4', reply_p50_hours: '1.5', reply_p75_hours: '50.0',
  hires: '2', hires_approximate: '1', time_to_hire_p50_days: '3.1', time_to_hire_p75_days: '4.0',
  active_jobs: null,
};
const employerWeek = {
  weekStart: '2026-09-28T00:00:00.000Z',
  applications: 12, answered: 9, answeredUntimed: 1, unanswered7d: 2, applicationsDue: 10,
  firstResponseP50Hours: 5.2, firstResponseP75Hours: 74.4,
  workerTurns: 7, turnsUnanswered7d: 1, turnsDue: 4, replyP50Hours: 1.5, replyP75Hours: 50,
  hires: 2, hiresApproximate: 1, timeToHireP50Days: 3.1, timeToHireP75Days: 4,
  activeJobs: null,
};
assert.deepEqual(analytics.mapEmployerWeeklyRow(employerWeekRow), employerWeek);
const employerSummaryRow = analytics.mapEmployerWeeklyRow({
  ...employerWeekRow,
  week_start: null,
  first_response_p50_hours: null, first_response_p75_hours: null,
  reply_p50_hours: null, reply_p75_hours: null,
  time_to_hire_p50_days: null, time_to_hire_p75_days: null,
  active_jobs: '6',
});
assert.equal(employerSummaryRow.weekStart, null, 'the whole-window row keeps its NULL week');
assert.equal(employerSummaryRow.firstResponseP50Hours, null, 'a NULL percentile stays null');
assert.equal(employerSummaryRow.timeToHireP75Days, null);
assert.equal(employerSummaryRow.activeJobs, 6);

assert.deepEqual(
  analytics.mapSlowestEmployerRow({
    employer_id: '7f3a9c2e-0000-4000-8000-000000000001', display_name: 'Empleador',
    applications: '5', unanswered_7d: '3', first_response_p50_hours: null, active_jobs: '2',
  }),
  {
    employerId: '7f3a9c2e-0000-4000-8000-000000000001', displayName: 'Empleador',
    applications: 5, unanswered7d: 3, firstResponseP50Hours: null, activeJobs: 2,
  },
);
assert.equal(
  analytics.mapSlowestEmployerRow({
    employer_id: '7f3a9c2e-0000-4000-8000-000000000002', display_name: 'Pinturas MX',
    applications: '4', unanswered_7d: '0', first_response_p50_hours: '12.5', active_jobs: '1',
  }).firstResponseP50Hours,
  12.5,
);
const staleJob = analytics.mapStaleJobRow({
  job_id: '0b1c2d3e-0000-4000-8000-000000000003', title: 'Ayudante de pintor',
  employer_id: '7f3a9c2e-0000-4000-8000-000000000002', display_name: 'Pinturas MX',
  posted_at: new Date('2026-09-01T12:00:00.000Z'), last_employer_action_at: new Date('2026-09-10T08:00:00.000Z'),
  days_idle: 28, waiting_applicants: '4', last_application_at: null,
});
assert.deepEqual(
  staleJob,
  {
    jobId: '0b1c2d3e-0000-4000-8000-000000000003', title: 'Ayudante de pintor',
    employerId: '7f3a9c2e-0000-4000-8000-000000000002', displayName: 'Pinturas MX',
    postedAt: '2026-09-01T12:00:00.000Z', lastEmployerActionAt: '2026-09-10T08:00:00.000Z',
    daysIdle: 28, waitingApplicants: 4, lastApplicationAt: null,
  },
);
const staleSincePosting = analytics.mapStaleJobRow({
  job_id: '0b1c2d3e-0000-4000-8000-000000000004', title: 'Albañil',
  employer_id: '7f3a9c2e-0000-4000-8000-000000000002', display_name: 'Pinturas MX',
  posted_at: new Date('2026-09-01T12:00:00.000Z'), last_employer_action_at: new Date('2026-09-01T12:00:00.000Z'),
  days_idle: 37, waiting_applicants: '1', last_application_at: new Date('2026-10-01T09:30:00.000Z'),
});
assert.equal(staleSincePosting.lastApplicationAt, '2026-10-01T09:30:00.000Z');
assert.equal(health.isIdleSincePosting(staleSincePosting), true, 'no recorded action: the clock started at posting');
assert.equal(health.isIdleSincePosting(staleJob), false);

// Durations: under 48 hours in hours, otherwise days; one decimal; NULL is a dash.
assert.equal(health.formatDuration(null), '—');
assert.equal(health.formatDuration(0), '0.0 h');
assert.equal(health.formatDuration(5.2), '5.2 h');
assert.equal(health.formatDuration(47.9), '47.9 h', 'just under 48 hours stays in hours');
assert.equal(health.formatDuration(48), '2.0 d', '48 hours switches to days');
assert.equal(health.formatDuration(74.4), '3.1 d');
assert.equal(health.formatHours(74.4), '74.4 h', 'chart end labels stay in the axis unit');
assert.equal(health.formatHours(null), '—');
assert.equal(health.formatDays(null), '—');
assert.equal(health.formatDays(0.5), '0.5 d', 'time to hire is always in days');
assert.equal(health.formatDays(3.1), '3.1 d');
assert.equal(health.formatDurationPair(5.2, 74.4), '5.2 h / 3.1 d');
assert.equal(health.formatDurationPair(null, null), '—', 'no timed answers: one dash, not "— / —"');

// Employer label: the business name, or the fallback with the id's first 4 characters.
assert.equal(health.employerLabel('Pinturas MX', '7f3a9c2e-0000-4000-8000-000000000002'), 'Pinturas MX');
assert.equal(health.employerLabel('Empleador', '7f3a9c2e-0000-4000-8000-000000000001'), 'Empleador · 7f3a');

// The weekly function's NULL-week row is the window summary; weeks come out oldest first.
const olderEmployerWeek = { ...employerWeek, weekStart: '2026-09-21T00:00:00.000Z', hiresApproximate: 0 };
const employerSplit = health.splitEmployerWeekly([
  { ...employerWeek, weekStart: null, applications: 30, activeJobs: 6 },
  employerWeek,
  olderEmployerWeek,
]);
assert.deepEqual(
  employerSplit.weekly.map((week) => week.weekStart),
  ['2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z'],
  'week rows oldest first, without the summary row',
);
assert.equal('activeJobs' in employerSplit.weekly[0], false, 'week rows carry no active-jobs figure');
assert.equal(employerSplit.summary.applications, 30, 'the summary is the SQL window row, not a sum of weeks');
assert.equal(employerSplit.summary.activeJobs, 6);
assert.equal('weekStart' in employerSplit.summary, false);
const emptySplit = health.splitEmployerWeekly([]);
assert.deepEqual(emptySplit.weekly, []);
assert.equal(emptySplit.summary.applications, 0, 'a missing summary row reads as zero');
assert.equal(emptySplit.summary.firstResponseP50Hours, null);
assert.equal(emptySplit.summary.activeJobs, 0);

// Settling: now < week_start + 14 days.
const healthNow = new Date('2026-10-08T15:00:00.000Z'); // a Thursday
assert.equal(health.isWeekSettling('2026-10-05T00:00:00.000Z', healthNow), true, 'the current week');
assert.equal(health.isWeekSettling('2026-09-28T00:00:00.000Z', healthNow), true, 'last week: settles on Oct 12');
assert.equal(health.isWeekSettling('2026-09-21T00:00:00.000Z', healthNow), false, 'settled on Oct 5');
assert.equal(
  health.isWeekSettling('2026-09-28T00:00:00.000Z', new Date('2026-10-12T00:00:00.000Z')),
  false,
  'exactly 14 days after the week starts it has settled',
);

const employerTableRows = health.weeklyTableRows([olderEmployerWeek, employerWeek], healthNow);
assert.deepEqual(employerTableRows.map((row) => row.label), ['Week of Sep 28', 'Week of Sep 21'], 'newest first');
assert.deepEqual(employerTableRows.map((row) => row.settling), [true, false]);
assert.deepEqual(employerTableRows.map((row) => row.approximate), [true, false], 'approx. only where a hire is approximate');
assert.equal(employerTableRows[0].applications, 12, 'table rows keep the week figures');

// Tile notes; every share is zero-safe.
const zeroFigures = emptySplit.summary;
assert.equal(health.firstResponseNote(employerWeek), '20% unanswered after 7 days', '2 of the 10 applications 7+ days old');
assert.equal(health.firstResponseNote({ ...zeroFigures, applicationsDue: 5 }), '0% unanswered after 7 days');
assert.equal(health.firstResponseNote({ ...zeroFigures, applications: 3 }), '— unanswered after 7 days', 'only young applications: no share yet');
assert.equal(health.firstResponseNote(zeroFigures), '— unanswered after 7 days', 'no applications, no share');
assert.equal(health.replyNote(employerWeek), '25% of worker messages unanswered', '1 of the 4 turns 7+ days old');
assert.equal(health.replyNote({ ...zeroFigures, turnsDue: 3 }), '0% of worker messages unanswered');
assert.equal(health.replyNote({ ...zeroFigures, workerTurns: 2 }), '— of worker messages unanswered', 'only young turns: no share yet');
assert.equal(health.answeredLabel(employerWeek), '9 · 1 untimed');
assert.equal(health.answeredLabel({ ...zeroFigures, answered: 1200 }), '1,200', 'no untimed part when every answer is timed');
assert.equal(health.hiresNote(employerWeek), '2 hires · 1 approximate');
assert.equal(health.hiresNote({ ...zeroFigures, hires: 3 }), '3 hires', 'no approximate part when none are approximate');
assert.equal(health.hiresNote({ ...zeroFigures, hires: 1 }), '1 hire');
assert.equal(health.hiresNote(zeroFigures), '0 hires');
assert.equal(health.staleJobsNote(6), 'of 6 active jobs');
assert.equal(health.staleJobsNote(1), 'of 1 active job');
assert.equal(health.staleJobsNote(0), 'of 0 active jobs');

// Stale jobs: the first 25, then "and N more".
assert.equal(health.STALE_JOBS_SHOWN, 25);
const thirtyJobs = Array.from({ length: 30 }, (_, i) => i);
assert.deepEqual(health.firstWithRest(thirtyJobs, 25), { shown: thirtyJobs.slice(0, 25), more: 5 });
assert.deepEqual(health.firstWithRest([1, 2], 25), { shown: [1, 2], more: 0 });

assert.equal(health.formatDay(null), '—');
assert.equal(health.formatDay('2026-09-01T23:30:00.000Z'), 'Sep 1, 2026', 'calendar day in UTC');
assert.equal(health.employersHref(4), '/analytics/employers?weeks=4');
assert.equal(health.employersHref(8), '/analytics/employers?weeks=8');

// ---- 2c: ops health ----
for (const getter of [
  'getMessageBacklog', 'getMessageFailures', 'getVoiceExtraction',
  'getTrustExtraction', 'getBillingInbox', 'getBillingInboxNow',
]) {
  assert.equal(typeof analytics[getter], 'function', `${getter} is exported`);
}
const opsNow = new Date('2026-10-08T15:00:00.000Z'); // a Thursday; the current week starts Oct 5

// Lanes: the SQL ids in display order, the page's labels, each lane's retry window.
assert.deepEqual(
  ops.LANES.map((lane) => [lane.id, lane.label, lane.retryWindow]),
  [
    ['reply', 'WhatsApp replies', '30 min'],
    ['admin', 'Admin replies', '10 min'],
    ['worker_notification', 'Worker notifications', '24 h'],
    ['employer_invite', 'Employer invites', '30 min'],
    ['employer_freeform', 'Employer free-text messages', '30 min'],
    ['job_alert', 'Job alerts (old lane)', '30 min'],
  ],
);
assert.equal(ops.isMessageLane('employer_freeform'), true);
assert.equal(ops.isMessageLane('sms'), false);
assert.equal(ops.isMessageLane(null), false);
assert.equal(ops.laneLabel('worker_notification'), 'Worker notifications');

// Mappers: pg returns BIGINT / NUMERIC as strings and TIMESTAMPTZ as a Date;
// SQL NULL stays null (never 0); an unknown lane id is an error, not a new row.
const opsBacklogRow = (lane, under, mid, late, stuck, oldest) => ({
  lane, open_under_1h: under, open_1_24h: mid, open_24_48h: late, stuck,
  oldest_stuck_at: oldest === null ? null : new Date(oldest),
});
assert.deepEqual(
  analytics.mapMessageBacklogRow(opsBacklogRow('reply', '4', '0', '0', '1', '2026-10-08T14:20:00.000Z')),
  { lane: 'reply', openUnder1h: 4, open1To24h: 0, open24To48h: 0, stuck: 1, oldestStuckAt: '2026-10-08T14:20:00.000Z' },
);
assert.equal(analytics.mapMessageBacklogRow(opsBacklogRow('admin', '0', '0', '0', '0', null)).oldestStuckAt, null);
assert.throws(
  () => analytics.mapMessageBacklogRow(opsBacklogRow('sms', '1', '0', '0', '0', null)),
  /Unexpected message lane: sms/,
);
// Shuffled on purpose: the page shows lanes in display order whatever the SQL order.
const opsBacklog = [
  opsBacklogRow('job_alert', '0', '0', '2', '2', '2026-10-07T10:00:00.000Z'),
  opsBacklogRow('worker_notification', '2', '1', '3', '3', '2026-10-07T12:00:00.000Z'),
  opsBacklogRow('employer_freeform', '0', '1', '1', '2', '2026-10-07T09:00:00.000Z'),
  opsBacklogRow('reply', '4', '0', '0', '1', '2026-10-08T14:20:00.000Z'),
  opsBacklogRow('admin', '0', '0', '0', '0', null),
  opsBacklogRow('employer_invite', '0', '0', '0', '0', null),
].map(analytics.mapMessageBacklogRow);
assert.deepEqual(
  ops.backlogRows(opsBacklog).map((row) => [row.label, row.stuckAfter, row.stuck]),
  [
    ['WhatsApp replies', 'stuck after 30 min', 1],
    ['Admin replies', 'stuck after 10 min', 0],
    ['Worker notifications', 'stuck after 24 h', 3],
    ['Employer invites', 'stuck after 30 min', 0],
    ['Employer free-text messages', 'stuck after 30 min', 2],
    ['Job alerts (old lane)', 'stuck after 30 min', 2],
  ],
);
assert.equal(ops.openMessages(opsBacklog), 14, 'open = under 1 h + 1–24 h + 24–48 h, every lane');
assert.equal(ops.stuckMessages(opsBacklog), 8);
assert.deepEqual(
  ops.oldestStuck(opsBacklog),
  { at: '2026-10-07T09:00:00.000Z', lane: 'employer_freeform' },
  'the oldest stuck message across lanes, and its lane',
);
assert.equal(ops.messagesStuckNote(opsBacklog, opsNow), 'oldest 30 h · Employer free-text messages');
assert.equal(
  ops.oldestStuck(opsBacklog.map((lane) => (lane.lane === 'worker_notification' ? { ...lane, oldestStuckAt: '2026-10-07T09:00:00.000Z' } : lane)))?.lane,
  'worker_notification',
  'an exact tie goes to the earlier lane in display order',
);
const opsIdleBacklog = opsBacklog.map((lane) => ({ ...lane, openUnder1h: 0, open1To24h: 0, open24To48h: 0, stuck: 0, oldestStuckAt: null }));
assert.equal(ops.openMessages(opsIdleBacklog), 0, 'nothing open: the card shows its empty state');
assert.equal(ops.oldestStuck(opsIdleBacklog), null);
assert.equal(ops.messagesStuckNote(opsIdleBacklog, opsNow), 'nothing stuck');

// Ages: whole minutes under an hour, whole hours under 48 hours, then whole days.
for (const [since, age] of [
  ['2026-10-08T15:00:00.000Z', 'under 1 min'],
  ['2026-10-08T14:59:30.000Z', 'under 1 min'],
  ['2026-10-08T15:05:00.000Z', 'under 1 min'], // ahead of the server clock
  ['2026-10-08T14:59:00.000Z', '1 min'],
  ['2026-10-08T14:20:00.000Z', '40 min'],
  ['2026-10-08T14:01:00.000Z', '59 min'],
  ['2026-10-08T14:00:00.000Z', '1 h'],
  ['2026-10-08T11:30:00.000Z', '3 h'],
  ['2026-10-06T15:01:00.000Z', '47 h'],
  ['2026-10-06T15:00:00.000Z', '2 d'],
  ['2026-10-06T09:00:00.000Z', '2 d'],
  ['2026-09-01T00:00:00.000Z', '37 d'],
]) {
  assert.equal(ops.formatAge(since, opsNow), age, `formatAge(${since})`);
}

// Weeks: newest first, labelled like the other tabs; only the week holding
// `now` is the current (partial) one, from Monday 00:00 UTC.
assert.equal(ops.isCurrentWeek('2026-10-05T00:00:00.000Z', opsNow), true);
assert.equal(ops.isCurrentWeek('2026-09-28T00:00:00.000Z', opsNow), false);
assert.equal(ops.isCurrentWeek('2026-10-05T00:00:00.000Z', new Date('2026-10-05T00:00:00.000Z')), true, 'Monday 00:00 UTC opens the week');
assert.equal(ops.isCurrentWeek('2026-10-05T00:00:00.000Z', new Date('2026-10-12T00:00:00.000Z')), false, 'and the next Monday closes it');
assert.deepEqual(
  ops.newestWeeksFirst([{ weekStart: '2026-09-28T00:00:00.000Z', n: 1 }, { weekStart: '2026-10-05T00:00:00.000Z', n: 2 }], opsNow),
  [
    { weekStart: '2026-10-05T00:00:00.000Z', n: 2, label: 'Week of Oct 5', current: true },
    { weekStart: '2026-09-28T00:00:00.000Z', n: 1, label: 'Week of Sep 28', current: false },
  ],
);

// Message failures: (week, lane) rows zero-filled for the five active lanes,
// job alerts only where they exist, whole-window rows per lane and for all.
assert.deepEqual(
  analytics.mapMessageFailuresRow({ week_start: new Date('2026-09-28T00:00:00.000Z'), lane: 'admin', created: '40', gave_up: '1', delivery_failed: '2' }),
  { weekStart: '2026-09-28T00:00:00.000Z', lane: 'admin', created: 40, gaveUp: 1, deliveryFailed: 2 },
);
assert.deepEqual(
  analytics.mapMessageFailuresRow({ week_start: null, lane: null, created: '0', gave_up: '0', delivery_failed: '0' }),
  { weekStart: null, lane: null, created: 0, gaveUp: 0, deliveryFailed: 0 },
  'the all-lanes window row keeps both NULLs',
);
assert.throws(
  () => analytics.mapMessageFailuresRow({ week_start: null, lane: 'sms', created: '1', gave_up: '0', delivery_failed: '0' }),
  /Unexpected message lane: sms/,
);
const opsW1 = '2026-09-28T00:00:00.000Z';
const opsW2 = '2026-10-05T00:00:00.000Z';
const opsFailureRows = [
  [opsW2, 'reply', 50, 0, 0], [opsW1, 'reply', 100, 2, 1], [null, 'reply', 150, 2, 1],
  [opsW1, 'admin', 10, 0, 0], [opsW2, 'admin', 0, 0, 0], [null, 'admin', 10, 0, 0],
  [opsW1, 'worker_notification', 20, 1, 0], [opsW2, 'worker_notification', 8, 0, 1], [null, 'worker_notification', 28, 1, 1],
  [opsW1, 'employer_invite', 0, 0, 0], [opsW2, 'employer_invite', 4, 1, 0], [null, 'employer_invite', 4, 1, 0],
  [opsW1, 'employer_freeform', 6, 0, 0], [opsW2, 'employer_freeform', 3, 0, 0], [null, 'employer_freeform', 9, 0, 0],
  [opsW1, 'job_alert', 2, 2, 0], [null, 'job_alert', 2, 2, 0],
  [null, null, 203, 6, 2],
].map(([week, lane, created, gaveUp, deliveryFailed]) => ({ weekStart: week, lane, created, gaveUp, deliveryFailed }));
const opsFailures = ops.splitMessageFailures(opsFailureRows);
assert.deepEqual(opsFailures.weeks, [opsW1, opsW2], 'weeks oldest first');
assert.deepEqual(
  opsFailures.lanes.map((lane) => lane.lane),
  ['reply', 'admin', 'worker_notification', 'employer_invite', 'employer_freeform', 'job_alert'],
  'lanes in display order; job alerts because they have rows',
);
assert.deepEqual(opsFailures.lanes[5].weekly, [{ created: 2, gaveUp: 2, deliveryFailed: 0 }, { created: 0, gaveUp: 0, deliveryFailed: 0 }], 'a missing job-alert week reads as zero');
assert.deepEqual(opsFailures.lanes[2].window, { created: 28, gaveUp: 1, deliveryFailed: 1 }, 'the per-lane window row');
assert.deepEqual(opsFailures.window, { created: 203, gaveUp: 6, deliveryFailed: 2 }, 'the all-lanes window row');
assert.equal(
  ops.splitMessageFailures([
    { weekStart: opsW1, lane: 'reply', created: 5, gaveUp: 0, deliveryFailed: 0 },
    { weekStart: null, lane: 'reply', created: 7, gaveUp: 1, deliveryFailed: 0 },
    { weekStart: null, lane: null, created: 9, gaveUp: 1, deliveryFailed: 0 },
  ]).window.created,
  9,
  'the window figures are the SQL window row, never re-summed from the weeks',
);
assert.deepEqual(
  ops.splitMessageFailures(opsFailureRows.filter((row) => row.lane !== 'job_alert')).lanes.map((lane) => lane.lane),
  ['reply', 'admin', 'worker_notification', 'employer_invite', 'employer_freeform'],
  'no job-alert rows, no job-alert lane',
);
assert.deepEqual(ops.splitMessageFailures([]), { weeks: [], lanes: [], window: { created: 0, gaveUp: 0, deliveryFailed: 0 } });

// Failure rate = (gave up + delivery failures) ÷ created, one decimal; a lane
// that created nothing has no rate (a gap in the chart, a dash in the table).
assert.deepEqual(
  opsFailures.lanes.map((lane) => lane.weekly.map(ops.failureRate)),
  [[3, 0], [0, null], [5, 12.5], [null, 25], [0, 0], [100, null]],
);
assert.equal(ops.failureRate({ created: 3, gaveUp: 1, deliveryFailed: 0 }), 33.3);
assert.equal(ops.failureRate({ created: 3, gaveUp: 1, deliveryFailed: 1 }), 66.7);
assert.equal(ops.failureRate(opsFailures.window), 3.9, '8 of 203');
assert.equal(ops.failureRate({ created: 5000, gaveUp: 1, deliveryFailed: 0 }), 0, 'the chart value is the rounded rate');
// As text, a rate never rounds a fact away.
for (const [created, gaveUp, deliveryFailed, text] of [
  [203, 6, 2, '3.9%'],
  [50, 0, 0, '0.0%'],
  [2, 2, 0, '100.0%'],
  [1000, 1, 0, '0.1%'],
  [5000, 1, 0, '<0.1%'],
  [5000, 4999, 0, '>99.9%'],
  [2000, 1000, 999, '>99.9%'],
  [0, 0, 0, '—'],
]) {
  assert.equal(ops.formatFailureRate({ created, gaveUp, deliveryFailed }), text, `formatFailureRate(${gaveUp} + ${deliveryFailed} of ${created})`);
}
assert.deepEqual(
  opsFailures.lanes.map(ops.latestRateLabel),
  ['0.0%', '—', '12.5%', '25.0%', '0.0%', '—'],
  'end labels: the current week; a lane that created nothing this week has none',
);
assert.equal(ops.failureChartEmpty(opsFailures), false);
assert.equal(
  ops.failureChartEmpty(ops.splitMessageFailures(opsFailureRows.map((row) => ({ ...row, created: 0, gaveUp: 0, deliveryFailed: 0 })))),
  true,
  'no lane created anything: the chart shows its empty state',
);
assert.equal(ops.failureChartEmpty(ops.splitMessageFailures([])), true);
assert.equal(ops.failureRateNote(opsFailures.window), '8 failed of 203 created');
assert.equal(ops.failureRateNote({ created: 0, gaveUp: 0, deliveryFailed: 0 }), '0 failed of 0 created');
assert.equal(ops.failedOfCreated({ created: 100, gaveUp: 2, deliveryFailed: 1 }), '3 / 100');
assert.equal(ops.failedOfCreated({ created: 5000, gaveUp: 1200, deliveryFailed: 34 }), '1,234 / 5,000');
assert.equal(ops.failedOfCreated({ created: 0, gaveUp: 0, deliveryFailed: 0 }), '—', 'nothing created: a dash, not 0 / 0');
const opsFailureTable = ops.failureTableRows(opsFailures, opsNow);
assert.deepEqual(opsFailureTable.map((row) => [row.label, row.current]), [['Week of Oct 5', true], ['Week of Sep 28', false]], 'newest first');
assert.deepEqual(opsFailureTable[0].cells.map(ops.failedOfCreated), ['0 / 50', '—', '1 / 8', '1 / 4', '0 / 3', '—'], 'cells line up with the lanes');

// Voice extraction: attempts; per-model rows count only attributed rows.
const opsVoiceRow = {
  week_start: null, model: null, processed: '20', failed: '6',
  failed_transcribe: '1', failed_empty_transcript: '0', failed_audio_read: '0', failed_model_call: '2',
  failed_bad_json: '1', failed_bad_shape: '1', failed_pipeline_error: '0', failed_unrecorded: '1',
  usable: '14', full_name_found: '12', city_found: '10', main_trade_found: '14', main_trade_other_due: '3',
  main_trade_other_found: '2', years_experience_found: '9', has_transportation_found: '13', availability_found: '7',
};
const opsVoiceWindow = {
  processed: 20, failed: 6, failedTranscribe: 1, failedEmptyTranscript: 0, failedAudioRead: 0, failedModelCall: 2,
  failedBadJson: 1, failedBadShape: 1, failedPipelineError: 0, failedUnrecorded: 1, usable: 14,
  fullNameFound: 12, cityFound: 10, mainTradeFound: 14, mainTradeOtherDue: 3, mainTradeOtherFound: 2,
  yearsExperienceFound: 9, hasTransportationFound: 13, availabilityFound: 7,
};
assert.deepEqual(analytics.mapVoiceExtractionRow(opsVoiceRow), { weekStart: null, model: null, ...opsVoiceWindow });
const opsHaiku = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const opsSonnet = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const opsVoiceZero = Object.fromEntries(Object.keys(opsVoiceWindow).map((key) => [key, 0]));
const opsVoiceModelHaiku = {
  ...opsVoiceZero, processed: 15, failed: 3, failedModelCall: 2, failedBadJson: 1, usable: 12,
  fullNameFound: 11, cityFound: 9, mainTradeFound: 12, mainTradeOtherDue: 3, mainTradeOtherFound: 2,
  yearsExperienceFound: 8, hasTransportationFound: 11, availabilityFound: 6,
};
const opsVoiceModelSonnet = {
  ...opsVoiceZero, processed: 3, failed: 1, failedBadShape: 1, usable: 2,
  fullNameFound: 1, cityFound: 1, mainTradeFound: 2, yearsExperienceFound: 1, hasTransportationFound: 2, availabilityFound: 1,
};
assert.equal(
  analytics.mapVoiceExtractionRow({ ...opsVoiceRow, week_start: new Date(opsW1), model: opsHaiku }).model,
  opsHaiku,
);
const opsVoice = ops.splitVoiceExtraction([
  { weekStart: null, model: opsSonnet, ...opsVoiceModelSonnet },
  { weekStart: opsW2, model: null, ...opsVoiceZero, processed: 8, failed: 2, failedBadJson: 1, failedBadShape: 1, usable: 6 },
  { weekStart: null, model: null, ...opsVoiceWindow },
  { weekStart: opsW1, model: opsHaiku, ...opsVoiceModelHaiku },
  { weekStart: opsW1, model: null, ...opsVoiceZero, processed: 12, failed: 4, failedTranscribe: 1, failedModelCall: 2, failedUnrecorded: 1, usable: 8 },
  { weekStart: null, model: opsHaiku, ...opsVoiceModelHaiku },
]);
assert.deepEqual(opsVoice.weekly.map((week) => [week.weekStart, week.processed]), [[opsW1, 12], [opsW2, 8]], 'all-model weeks, oldest first');
assert.equal('model' in opsVoice.weekly[0], false);
assert.deepEqual(opsVoice.window, opsVoiceWindow, 'the window row');
assert.deepEqual(opsVoice.models.map((model) => model.model), [opsHaiku, opsSonnet], 'window per-model rows, most attempts first');
assert.equal(ops.splitVoiceExtraction([]).window.processed, 0, 'a missing window row reads as zero');
assert.equal(
  ops.splitVoiceExtraction([
    { weekStart: opsW1, model: null, ...opsVoiceZero, processed: 3 },
    { weekStart: null, model: null, ...opsVoiceZero, processed: 4 },
  ]).window.processed,
  4,
  'the voice window is the SQL window row, never re-summed',
);

// Causes: fixed labels and order; NULL kind = Cause not recorded.
assert.deepEqual(
  ops.FAILURE_CAUSES.map((cause) => [cause.cause, cause.label]),
  [
    ['transcribe', 'Transcription failed'],
    ['empty_transcript', 'Empty transcript'],
    ['audio_read', 'Transcript unreadable'],
    ['model_call', 'AI call failed'],
    ['bad_json', 'AI reply unreadable'],
    ['bad_shape', 'AI reply incomplete'],
    ['pipeline_error', 'Pipeline error'],
    ['unrecorded', 'Cause not recorded'],
  ],
);
assert.deepEqual(
  ops.failureReasons(opsVoiceWindow).map((reason) => [reason.label, reason.count]),
  [['AI call failed', 2], ['Transcription failed', 1], ['AI reply unreadable', 1], ['AI reply incomplete', 1], ['Cause not recorded', 1]],
  'most first; ties keep the fixed order; causes with no failures are left out',
);
assert.deepEqual(ops.topFailureCauses(opsVoiceWindow), [{ cause: 'model_call', label: 'AI call failed', count: 2 }]);
assert.equal(ops.topCauseLabel(opsVoiceWindow), 'AI call failed');
assert.deepEqual(
  ops.topFailureCauses(opsVoice.weekly[1]).map((reason) => reason.cause),
  ['bad_json', 'bad_shape'],
  'a tie keeps every tied cause, in the fixed order',
);
assert.equal(ops.topCauseLabel(opsVoice.weekly[1]), 'AI reply unreadable, AI reply incomplete (tied)', 'a tie says so, never a winner');
assert.equal(ops.topCauseLabel({ ...opsVoiceZero, failed: 4, failedUnrecorded: 3, failedModelCall: 1 }), 'Cause not recorded', 'unrecorded can be the top cause');
assert.equal(ops.topCauseLabel(opsVoiceZero), '—');
assert.deepEqual(ops.topFailureCauses(opsVoiceZero), []);

// Whole-percent shares never round a fact away.
for (const [part, whole, text] of [
  [14, 20, '70%'], [0, 5, '0%'], [5, 5, '100%'], [1, 300, '<1%'], [994, 1000, '99%'],
  [995, 1000, '>99%'], [996, 1000, '>99%'], [0, 0, '—'],
]) {
  assert.equal(ops.wholePercent(part, whole), text, `wholePercent(${part}, ${whole})`);
}
assert.equal(ops.voiceSuccess(opsVoiceWindow), '70%', '14 usable of 20 attempts');
assert.equal(ops.voiceSuccess({ ...opsVoiceZero, processed: 1000, usable: 996, failed: 4, failedModelCall: 4 }), '>99%', 'not 100% while anything failed');
assert.equal(ops.voiceSuccess(opsVoiceZero), '—', 'no attempts, no share');
assert.equal(ops.voiceSuccessNote(opsVoiceWindow), 'top cause: AI call failed');
assert.equal(ops.voiceSuccessNote(opsVoice.weekly[1]), 'top causes: AI reply unreadable, AI reply incomplete (tied)');
const opsFiveWayTie = {
  ...opsVoiceZero, processed: 5, failed: 5, failedTranscribe: 1, failedEmptyTranscript: 1, failedAudioRead: 1,
  failedModelCall: 1, failedPipelineError: 1,
};
assert.equal(
  ops.topCauseLabel(opsFiveWayTie),
  'Transcription failed, Empty transcript, Transcript unreadable, AI call failed, Pipeline error (tied)',
  'the weekly table names every tied cause',
);
assert.equal(
  ops.voiceSuccessNote(opsFiveWayTie),
  'top causes: Transcription failed, Empty transcript + 3 more (tied)',
  'the tile names two and counts the rest',
);
assert.equal(ops.voiceSuccessNote({ ...opsVoiceZero, processed: 4, usable: 4 }), 'no failures');
assert.equal(ops.voiceSuccessNote(opsVoiceZero), 'no voice notes');

// Field completeness: share found of usable rows; Other trade only counts rows
// whose main trade is "other" (its own denominator).
assert.deepEqual(
  ops.COMPLETENESS_FIELDS.map((field) => field.label),
  ['Full name', 'City', 'Main trade', 'Other trade (when main trade is "other")', 'Years of experience', 'Has transportation', 'Availability'],
);
assert.deepEqual(ops.fieldShare(opsVoiceWindow, 'fullName'), { found: 12, of: 14, share: '86%' });
assert.deepEqual(ops.fieldShare(opsVoiceWindow, 'mainTradeOther'), { found: 2, of: 3, share: '67%' });
assert.deepEqual(ops.fieldShare(opsVoiceModelSonnet, 'mainTradeOther'), { found: 0, of: 0, share: '—' }, 'no "other" trades: a dash, not 0%');
const opsCompleteness = ops.completenessTable(opsVoice.window, opsVoice.models);
assert.deepEqual(
  opsCompleteness.columns,
  [
    { key: 'all', label: 'All models', model: false, usable: 14 },
    { key: `model:${opsHaiku}`, label: opsHaiku, model: true, usable: 12 },
    { key: `model:${opsSonnet}`, label: opsSonnet, model: true, usable: 2 },
  ],
  'more than one model: a column per model after the all-models column',
);
assert.deepEqual(opsCompleteness.rows.map((row) => row.cells.map((cell) => cell.share)), [
  ['86%', '92%', '50%'],
  ['71%', '75%', '50%'],
  ['100%', '100%', '100%'],
  ['67%', '67%', '—'],
  ['64%', '67%', '50%'],
  ['93%', '92%', '100%'],
  ['50%', '50%', '50%'],
]);
assert.deepEqual(
  ops.completenessTable(opsVoice.window, [{ ...opsVoiceModelHaiku, model: opsHaiku }]).columns,
  [{ key: 'all', label: 'Found', model: false, usable: 14 }],
  'one model: a single column',
);

// Trust extraction: per version where rows exist; an empty week keeps its zero row.
assert.deepEqual(
  analytics.mapTrustExtractionRow({ week_start: new Date(opsW1), extractor_version: 'v1', extractions: '5', failed: '1', not_enough_detail: '1', avg_sections: '2.7' }),
  { weekStart: opsW1, extractorVersion: 'v1', extractions: 5, failed: 1, notEnoughDetail: 1, avgSections: 2.7 },
);
assert.equal(
  analytics.mapTrustExtractionRow({ week_start: null, extractor_version: null, extractions: '0', failed: '0', not_enough_detail: '0', avg_sections: null }).avgSections,
  null,
  'no model-backed extraction: no average (never 0)',
);
const opsW0 = '2026-09-21T00:00:00.000Z';
const opsTrust = ops.splitTrustExtraction([
  { weekStart: null, extractorVersion: null, extractions: 8, failed: 1, notEnoughDetail: 1, avgSections: 3 },
  { weekStart: opsW2, extractorVersion: 'v2', extractions: 2, failed: 0, notEnoughDetail: 0, avgSections: 3.5 },
  { weekStart: opsW1, extractorVersion: null, extractions: 5, failed: 1, notEnoughDetail: 1, avgSections: 2.7 },
  { weekStart: opsW0, extractorVersion: null, extractions: 0, failed: 0, notEnoughDetail: 0, avgSections: null },
  { weekStart: opsW2, extractorVersion: 'v1', extractions: 1, failed: 0, notEnoughDetail: 0, avgSections: 3 },
  { weekStart: opsW2, extractorVersion: null, extractions: 3, failed: 0, notEnoughDetail: 0, avgSections: 3.3 },
  { weekStart: opsW1, extractorVersion: 'v1', extractions: 5, failed: 1, notEnoughDetail: 1, avgSections: 2.7 },
  { weekStart: null, extractorVersion: 'v1', extractions: 6, failed: 1, notEnoughDetail: 1, avgSections: 2.8 },
  { weekStart: null, extractorVersion: 'v2', extractions: 2, failed: 0, notEnoughDetail: 0, avgSections: 3.5 },
]);
assert.deepEqual(opsTrust.window, { extractions: 8, failed: 1, notEnoughDetail: 1, avgSections: 3 });
assert.deepEqual(
  ops.newestWeeksFirst(opsTrust.weekly, opsNow).map((row) => [row.label, row.version, row.extractions, row.current]),
  [
    ['Week of Oct 5', 'v1', 1, true],
    ['Week of Oct 5', 'v2', 2, true],
    ['Week of Sep 28', 'v1', 5, false],
    ['Week of Sep 21', null, 0, false],
  ],
  'one row per version that week; a week with none keeps its zero row',
);
assert.equal(ops.splitTrustExtraction([]).window.extractions, 0);
assert.equal(ops.formatAvgSections(2.7), '2.7');
assert.equal(ops.formatAvgSections(3), '3.0');
assert.equal(ops.formatAvgSections(null), '—');

// Billing inbox.
assert.deepEqual(
  analytics.mapBillingInboxRow({ week_start: new Date(opsW1), event_type: 'invoice.payment_failed', received: '4', processed: '3', skipped: '0', failed: '1', retried: '2', payment_failed_invoices: '4' }),
  { weekStart: opsW1, eventType: 'invoice.payment_failed', received: 4, processed: 3, skipped: 0, failed: 1, retried: 2, paymentFailedInvoices: 4 },
);
assert.deepEqual(
  analytics.mapBillingInboxNowRow({ stuck_received: '2', failed_now: '1', unresolved_older: '3', oldest_stuck_at: new Date('2026-10-08T14:48:00.000Z') }),
  { stuckReceived: 2, failedNow: 1, unresolvedOlder: 3, oldestStuckAt: '2026-10-08T14:48:00.000Z' },
);
const opsInboxIdle = analytics.mapBillingInboxNowRow({ stuck_received: '0', failed_now: '0', unresolved_older: '0', oldest_stuck_at: null });
assert.equal(opsInboxIdle.oldestStuckAt, null);
assert.equal(opsInboxIdle.unresolvedOlder, 0);
const opsBillingZero = { received: 0, processed: 0, skipped: 0, failed: 0, retried: 0, paymentFailedInvoices: 0 };
const opsBilling = ops.splitBillingInbox([
  { ...opsBillingZero, weekStart: null, eventType: 'customer.created', received: 1, skipped: 1 },
  { ...opsBillingZero, weekStart: opsW2, eventType: null, received: 3, processed: 2, failed: 1 },
  { ...opsBillingZero, weekStart: null, eventType: null, received: 12, processed: 4, skipped: 7, failed: 1, retried: 2, paymentFailedInvoices: 1 },
  { ...opsBillingZero, weekStart: opsW1, eventType: null, received: 9, processed: 2, skipped: 7, retried: 2, paymentFailedInvoices: 1 },
  { ...opsBillingZero, weekStart: null, eventType: 'invoice.payment_failed', received: 1, processed: 1, paymentFailedInvoices: 1 },
  { ...opsBillingZero, weekStart: null, eventType: 'customer.subscription.trial_will_end', received: 3, skipped: 3 },
  { ...opsBillingZero, weekStart: null, eventType: 'charge.refunded', received: 3, skipped: 3 },
  { ...opsBillingZero, weekStart: opsW1, eventType: 'charge.refunded', received: 3, skipped: 3 },
]);
assert.deepEqual(opsBilling.weekly.map((week) => [week.weekStart, week.received]), [[opsW1, 9], [opsW2, 3]], 'all-type weeks, oldest first');
assert.equal(opsBilling.window.received, 12, 'the window row');
assert.deepEqual(
  ops.skippedByType(opsBilling.eventTypes),
  [
    { eventType: 'charge.refunded', skipped: 3 },
    { eventType: 'customer.subscription.trial_will_end', skipped: 3 },
    { eventType: 'customer.created', skipped: 1 },
  ],
  'skipped types only, most first, then by name',
);
assert.equal(ops.splitBillingInbox([]).window.received, 0);
const opsInbox = { stuckReceived: 2, failedNow: 1, unresolvedOlder: 3, oldestStuckAt: '2026-10-08T14:48:00.000Z' };
assert.equal(ops.billingStuck(opsInbox), 3, 'stuck + failed within the last hour; the older unresolved ones are not in the tile value');
assert.equal(ops.billingStuckNote({ ...opsInbox, unresolvedOlder: 0 }, opsNow), 'oldest 12 min', 'something stuck, nothing dead-lettered');
assert.equal(
  ops.billingStuckNote(opsInbox, opsNow),
  'oldest 12 min · 3 need a manual redrive',
  'something stuck and some dead-lettered in the last 14 days',
);
assert.equal(
  ops.billingStuckNote({ ...opsInbox, unresolvedOlder: 1 }, opsNow),
  'oldest 12 min · 1 needs a manual redrive',
  'one dead-lettered: singular',
);
assert.equal(ops.billingStuckNote({ ...opsInboxIdle, unresolvedOlder: 3 }, opsNow), '3 need a manual redrive', 'nothing stuck now, some dead-lettered');
assert.equal(ops.billingStuckNote({ ...opsInboxIdle, unresolvedOlder: 1 }, opsNow), '1 needs a manual redrive');
assert.equal(ops.billingStuckNote(opsInboxIdle, opsNow), 'nothing stuck');
assert.equal(
  ops.billingLiveLine(opsInbox, opsNow),
  '2 stuck in received · 1 failed in the last hour · oldest 12 min · 3 dead-lettered in the last 14 days (redrive from the DLQ)',
);
assert.equal(
  ops.billingLiveLine({ ...opsInbox, unresolvedOlder: 0 }, opsNow),
  '2 stuck in received · 1 failed in the last hour · oldest 12 min',
  'no dead-lettered part when there are none',
);
assert.equal(
  ops.billingLiveLine({ ...opsInboxIdle, unresolvedOlder: 1 }, opsNow),
  '0 stuck in received · 0 failed in the last hour · 1 dead-lettered in the last 14 days (redrive from the DLQ)',
  'nothing stuck now, one dead-lettered',
);
assert.equal(ops.billingLiveLine(opsInboxIdle, opsNow), '0 stuck in received · 0 failed in the last hour');
// Events failed 20-60 minutes ago are already dead-lettered: the line never
// says they are being retried.
for (const line of [
  ops.billingLiveLine(opsInbox, opsNow),
  ops.billingLiveLine(opsInboxIdle, opsNow),
  ops.billingLiveLine({ ...opsInboxIdle, unresolvedOlder: 1 }, opsNow),
]) {
  assert.doesNotMatch(line, /failed, retrying/, 'a failed event is not necessarily still being retried');
  assert.doesNotMatch(line, /will retry/);
  assert.doesNotMatch(line, /unresolved/);
}
assert.equal(ops.opsHref(4), '/analytics/ops?weeks=4');
assert.equal(ops.opsHref(12), '/analytics/ops?weeks=12');

console.log('check-analytics-helpers: all assertions passed');
