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
        .replaceAll("'../types'", "'./types.mjs'"),
    );
  }
});

const analytics = await import(pathToFileURL(resolve(outDir, 'admin-analytics.mjs')));
const funnel = await import(pathToFileURL(resolve(outDir, 'funnel.mjs')));
const health = await import(pathToFileURL(resolve(outDir, 'employer-health.mjs')));

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

console.log('check-analytics-helpers: all assertions passed');
