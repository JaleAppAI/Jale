import assert from 'node:assert/strict';
import { captureConsole, compileAdminSources } from './lib/check-harness.mjs';

// Date helpers must print UTC whatever the host zone; CI runs in UTC, where a
// helper that forgot timeZone: 'UTC' would still pass.
process.env.TZ = 'America/Los_Angeles';

// Structure-preserving compile: admin-analytics imports the audit helpers
// from src/lib/server/audit/, which a flattened emit cannot resolve.
const { load } = compileAdminSources({
  name: 'analytics-helpers',
  sources: [
    'src/lib/server/admin-analytics.ts',
    'src/lib/funnel.ts',
    'src/lib/employer-health.ts',
    'src/lib/ops-health.ts',
    'src/lib/restarts.ts',
    'src/lib/digest.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-sqs': 'scripts/fakes/sqs.mjs',
    '@aws-sdk/client-cloudwatch': 'scripts/fakes/cloudwatch.mjs',
  },
});

const analytics = await load('src/lib/server/admin-analytics.ts');
const funnel = await load('src/lib/funnel.ts');
const analyticsFormat = await load('src/lib/analytics-format.ts');
const health = await load('src/lib/employer-health.ts');
const ops = await load('src/lib/ops-health.ts');
const restarts = await load('src/lib/restarts.ts');
const digest = await load('src/lib/digest.ts');

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
// K3.0: a number of weeks is this ISO week and the weeks - 1 before it.
const eightWeeks = analytics.resolveRange(8, now);
assert.equal(eightWeeks.bucket, 'week');
assert.equal(eightWeeks.from.toISOString(), '2026-07-06T00:00:00.000Z', '8 weeks: this ISO week and the 7 before it');
assert.equal(analytics.bucketStarts(eightWeeks.from, eightWeeks.bucket, now).length, 8, 'exactly 8 weekly buckets, the last one partial');
const twentySixWeeks = analytics.resolveRange(26, now);
assert.equal(twentySixWeeks.from.toISOString(), '2026-03-02T00:00:00.000Z');
assert.equal(analytics.bucketStarts(twentySixWeeks.from, twentySixWeeks.bucket, now).length, 26);

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

const ORG_1 = '00000000-0000-4000-8000-0000000000a1';
assert.deepEqual(
  analytics.mapPayingEmployerRow({
    employer_id: '00000000-0000-0000-0000-000000000001',
    display_name: 'IT Analytics Co', plan_code: 'pro_monthly', status: 'active',
    current_period_end: new Date('2026-09-15T00:00:00.000Z'), cancel_at_period_end: false,
    organization_id: ORG_1, members_active: '3', seats_used: '2', seats_pending: '1', seats_suspended: '0', seat_limit: 5,
  }),
  {
    employerId: '00000000-0000-0000-0000-000000000001', displayName: 'IT Analytics Co',
    planCode: 'pro_monthly', status: 'active',
    currentPeriodEnd: '2026-09-15T00:00:00.000Z', cancelAtPeriodEnd: false,
    organizationId: ORG_1, membersActive: 3, seatsUsed: 2, seatsPending: 1, seatsSuspended: 0, seatLimit: 5,
  },
);
{
  const noLimit = analytics.mapPayingEmployerRow({
    employer_id: '00000000-0000-0000-0000-000000000002',
    display_name: 'Empleador', plan_code: 'pro_monthly', status: 'trialing',
    current_period_end: null, cancel_at_period_end: true,
    organization_id: ORG_1, members_active: 1, seats_used: 0, seats_pending: 0, seats_suspended: 0, seat_limit: null,
  });
  assert.equal(noLimit.currentPeriodEnd, undefined, 'null period end maps to undefined');
  assert.equal(noLimit.seatLimit, null, 'a plan without a seat limit stays null');
  assert.equal(noLimit.membersActive, 1);
}

// ---- Phase 5: companies ----
assert.equal(analytics.COMPANIES_LIMIT, 100);
const companyRow = {
  organization_id: ORG_1, owner_id: '00000000-0000-0000-0000-000000000001', display_name: 'IT Analytics Co',
  created_at: new Date('2026-09-01T10:00:00.000Z'), plan_code: 'employer_pro', plan_status: 'active',
  members_active: '3', seats_used: '2', seats_pending: '1', seats_suspended: '1', seat_limit: 5, active_jobs: '4',
};
assert.deepEqual(analytics.mapCompanySummaryRow(companyRow), {
  organizationId: ORG_1, ownerId: '00000000-0000-0000-0000-000000000001', displayName: 'IT Analytics Co',
  createdAt: '2026-09-01T10:00:00.000Z', planCode: 'employer_pro', planStatus: 'active',
  membersActive: 3, seatsUsed: 2, seatsPending: 1, seatsSuspended: 1, seatLimit: 5, activeJobs: 4,
});
assert.deepEqual(
  analytics.mapCompanySummaryRow({ ...companyRow, plan_code: 'employer_free', plan_status: null, seat_limit: null }),
  {
    organizationId: ORG_1, ownerId: '00000000-0000-0000-0000-000000000001', displayName: 'IT Analytics Co',
    createdAt: '2026-09-01T10:00:00.000Z', planCode: 'employer_free', planStatus: null,
    membersActive: 3, seatsUsed: 2, seatsPending: 1, seatsSuspended: 1, seatLimit: null, activeJobs: 4,
  },
  'a free company has no plan status, and a missing limit stays null',
);
const memberRow = {
  user_id: '00000000-0000-0000-0000-0000000000b1', display_name: 'Rosa Mendez', role: 'foreman', status: 'suspended',
  billing_suspended: true, joined_at: new Date('2026-09-02T10:00:00.000Z'),
  status_changed_at: new Date('2026-09-20T10:00:00.000Z'), active_jobs: '2',
};
assert.deepEqual(analytics.mapCompanyMemberRow(memberRow), {
  userId: '00000000-0000-0000-0000-0000000000b1', displayName: 'Rosa Mendez', role: 'foreman', status: 'suspended',
  billingSuspended: true, joinedAt: '2026-09-02T10:00:00.000Z', statusChangedAt: '2026-09-20T10:00:00.000Z', activeJobs: 2,
});
assert.deepEqual(
  analytics.mapCompanyMemberRow({ ...memberRow, display_name: null, role: 'owner', status: 'active', billing_suspended: false, status_changed_at: null }),
  {
    userId: '00000000-0000-0000-0000-0000000000b1', displayName: null, role: 'owner', status: 'active',
    billingSuspended: false, joinedAt: '2026-09-02T10:00:00.000Z', statusChangedAt: null, activeJobs: 2,
  },
  'a member with no name and no status change keeps both as null',
);
assert.throws(() => analytics.mapCompanyMemberRow({ ...memberRow, role: 'admin' }), /Unexpected member role/);
assert.throws(() => analytics.mapCompanyMemberRow({ ...memberRow, status: 'banned' }), /Unexpected member status/);

// ---- 2a: onboarding funnel ----
assert.equal(analytics.parseFunnelWeeks('13'), 13);
assert.equal(analytics.parseFunnelWeeks('26'), 26);
assert.equal(analytics.parseFunnelWeeks('8'), 8);
assert.equal(analytics.parseFunnelWeeks('4'), 8, 'only 8/13/26 are offered (K3.0); old 4/12 links fall back');
assert.equal(analytics.parseFunnelWeeks('12'), 8);
assert.equal(analytics.parseFunnelWeeks(undefined), 8);
assert.equal(analytics.parseFunnelWeeks(['13']), 8, 'array (repeated param) falls back');
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
assert.equal(funnel.shareShade(0, 10), 'color-mix(in srgb, var(--chart-1) 6%, transparent)', 'the cohort wash is a token, so it works in dark mode');
assert.equal(funnel.shareShade(10, 10), 'color-mix(in srgb, var(--chart-1) 36%, transparent)');
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
    organization_id: null,
  }),
  {
    employerId: '7f3a9c2e-0000-4000-8000-000000000001', displayName: 'Empleador',
    applications: 5, unanswered7d: 3, firstResponseP50Hours: null, activeJobs: 2,
    organizationId: null,
  },
);
assert.equal(
  analytics.mapSlowestEmployerRow({
    employer_id: '7f3a9c2e-0000-4000-8000-000000000002', display_name: 'Pinturas MX',
    applications: '4', unanswered_7d: '0', first_response_p50_hours: '12.5', active_jobs: '1',
    organization_id: ORG_1,
  }).firstResponseP50Hours,
  12.5,
);
assert.equal(
  analytics.mapSlowestEmployerRow({
    employer_id: '7f3a9c2e-0000-4000-8000-000000000002', display_name: 'Pinturas MX',
    applications: '4', unanswered_7d: '0', first_response_p50_hours: '12.5', active_jobs: '1',
    organization_id: ORG_1,
  }).organizationId,
  ORG_1,
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
// K3.1 #9 (CR-3): failed_last_24h is a pg BIGINT string, mapped like failed_now.
assert.deepEqual(
  analytics.mapBillingInboxNowRow({ stuck_received: '2', failed_now: '1', failed_last_24h: '5', unresolved_older: '3', oldest_stuck_at: new Date('2026-10-08T14:48:00.000Z') }),
  { stuckReceived: 2, failedNow: 1, failedLast24h: 5, unresolvedOlder: 3, oldestStuckAt: '2026-10-08T14:48:00.000Z' },
);
const opsInboxIdle = analytics.mapBillingInboxNowRow({ stuck_received: '0', failed_now: '0', failed_last_24h: '0', unresolved_older: '0', oldest_stuck_at: null });
assert.equal(opsInboxIdle.oldestStuckAt, null);
assert.equal(opsInboxIdle.unresolvedOlder, 0);
assert.equal(opsInboxIdle.failedLast24h, 0, 'a zero count is 0, never undefined');
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
const opsInbox = { stuckReceived: 2, failedNow: 1, failedLast24h: 4, unresolvedOlder: 3, oldestStuckAt: '2026-10-08T14:48:00.000Z' };
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

// ---- 2d: start over and back, operator resets, applicant digest ----
for (const getter of ['getOnboardingRestarts', 'getOperatorResets', 'getDigestAdoption', 'getDigestSends']) {
  assert.equal(typeof analytics[getter], 'function', `${getter} is exported`);
}
const rsNow = new Date('2026-10-08T15:00:00.000Z'); // a Thursday; the current week starts Oct 5
const rsW0 = '2026-09-14T00:00:00.000Z';
const rsW1 = '2026-09-21T00:00:00.000Z';
const rsW2 = '2026-09-28T00:00:00.000Z';
const rsW3 = '2026-10-05T00:00:00.000Z';

// stepOrder is exported unchanged: 113's order, unknown keys last.
assert.equal(funnel.stepOrder('start.choose_language'), 0);
assert.equal(funnel.stepOrder('legal.review'), 2);
assert.equal(funnel.stepOrder('profile.name'), 5);
assert.equal(funnel.stepOrder('profile.photo_type'), 16);
assert.equal(funnel.stepOrder('something.new'), 17, 'an unknown step sorts after every known one');

// Mappers: pg returns BIGINT as a string and TIMESTAMPTZ as a Date; a NULL
// week is the whole window, a NULL step is all steps; a door outside
// all / whatsapp / web is an error.
const rsRow = {
  week_start: new Date(rsW2), door: 'whatsapp', step_key: 'profile.location',
  reached: '10', restart_workers: '2', restart_presses: '3', back_workers: '4', back_presses: '6',
};
assert.deepEqual(analytics.mapOnboardingRestartRow(rsRow), {
  weekStart: rsW2, door: 'whatsapp', stepKey: 'profile.location',
  reached: 10, restartWorkers: 2, restartPresses: 3, backWorkers: 4, backPresses: 6,
});
assert.deepEqual(
  analytics.mapOnboardingRestartRow({ ...rsRow, week_start: null, door: 'all', step_key: null }),
  { weekStart: null, door: 'all', stepKey: null, reached: 10, restartWorkers: 2, restartPresses: 3, backWorkers: 4, backPresses: 6 },
  'the window all-steps row keeps both NULLs',
);
assert.throws(() => analytics.mapOnboardingRestartRow({ ...rsRow, door: 'other' }), /Unexpected restarts door: other/);

// Fixture: the SQL's rows for every door, shuffled. 'all' is the SQL's own row
// (distinct across doors), so it is never the sum of the two doors; an
// all-steps row (stepKey null) counts workers distinct across steps, so it is
// never the sum of the step rows either (presses are).
const rsFig = (reached, restartWorkers, restartPresses, backWorkers, backPresses) =>
  ({ reached, restartWorkers, restartPresses, backWorkers, backPresses });
const rsRows = [
  { weekStart: null, door: 'all', stepKey: 'profile.location', ...rsFig(25, 3, 4, 5, 7) },
  { weekStart: rsW3, door: 'all', stepKey: 'profile.location', ...rsFig(9, 2, 2, 2, 3) },
  { weekStart: null, door: 'web', stepKey: 'profile.location', ...rsFig(10, 0, 0, 3, 5) },
  { weekStart: rsW3, door: 'all', stepKey: null, ...rsFig(20, 3, 4, 3, 5) },
  { weekStart: null, door: 'all', stepKey: 'trust.question.2', ...rsFig(4, 1, 1, 2, 2) },
  { weekStart: rsW1, door: 'all', stepKey: 'profile.location', ...rsFig(8, 1, 2, 2, 3) },
  { weekStart: null, door: 'web', stepKey: null, ...rsFig(12, 0, 0, 3, 5) },
  { weekStart: null, door: 'all', stepKey: 'legal.review', ...rsFig(40, 0, 0, 2, 2) },
  { weekStart: rsW2, door: 'web', stepKey: 'profile.location', ...rsFig(4, 1, 1, 3, 5) },
  { weekStart: rsW2, door: 'web', stepKey: null, ...rsFig(4, 1, 1, 3, 5) },
  { weekStart: null, door: 'all', stepKey: 'profile.trade', ...rsFig(300, 1, 1, 0, 0) },
  { weekStart: rsW1, door: 'all', stepKey: 'legal.review', ...rsFig(20, 0, 0, 2, 2) },
  { weekStart: rsW1, door: 'all', stepKey: null, ...rsFig(25, 1, 2, 3, 5) },
  { weekStart: null, door: 'whatsapp', stepKey: 'profile.location', ...rsFig(14, 3, 4, 2, 2) },
  { weekStart: null, door: 'whatsapp', stepKey: null, ...rsFig(20, 3, 4, 2, 2) },
  { weekStart: rsW3, door: 'all', stepKey: 'profile.name', ...rsFig(12, 1, 1, 1, 1) },
  { weekStart: rsW3, door: 'all', stepKey: 'profile.trade', ...rsFig(6, 1, 1, 1, 1) },
  { weekStart: null, door: 'all', stepKey: null, ...rsFig(400, 5, 7, 8, 11) },
  { weekStart: null, door: 'all', stepKey: 'profile.name', ...rsFig(30, 1, 1, 0, 0) },
  { weekStart: '2026-08-31T00:00:00.000Z', door: 'all', stepKey: 'profile.name', ...rsFig(5, 9, 9, 9, 9) },
  { weekStart: '2026-08-31T00:00:00.000Z', door: 'all', stepKey: null, ...rsFig(5, 9, 9, 9, 9) },
];

// Start over is a WhatsApp command: the web door has none.
assert.equal(restarts.hasStartOver('all'), true);
assert.equal(restarts.hasStartOver('whatsapp'), true);
assert.equal(restarts.hasStartOver('web'), false);

// By step: the door's window step rows in onboarding order (never the
// all-steps row); workers · share of the workers who were at the step.
assert.deepEqual(restarts.restartStepRows(rsRows, 'all'), [
  { stepKey: 'legal.review', label: 'Terms', reached: 40, startedOver: '0 · 0%', wentBack: '2 · 5%', presses: 2 },
  { stepKey: 'profile.name', label: 'Name', reached: 30, startedOver: '1 · 3%', wentBack: '0 · 0%', presses: 1 },
  { stepKey: 'profile.location', label: 'Location', reached: 25, startedOver: '3 · 12%', wentBack: '5 · 20%', presses: 11 },
  { stepKey: 'profile.trade', label: 'Trade', reached: 300, startedOver: '1 · <1%', wentBack: '0 · 0%', presses: 1 },
  { stepKey: 'trust.question.2', label: 'Trust question 2', reached: 4, startedOver: '1 · 25%', wentBack: '2 · 50%', presses: 3 },
], 'onboarding order; a small share never rounds to 0%');
assert.deepEqual(
  restarts.restartStepRows(rsRows, 'whatsapp').map((row) => [row.label, row.reached, row.startedOver]),
  [['Location', 14, '3 · 21%']],
  'a door shows its own window rows, never re-derived from All',
);
assert.deepEqual(
  restarts.restartStepRows(rsRows, 'web'),
  [{ stepKey: 'profile.location', label: 'Location', reached: 10, startedOver: '—', wentBack: '3 · 30%', presses: 5 }],
  'the web door has no start over: a dash, and only back presses',
);

// The total row: the window all-steps row, never a sum of the steps
// (the steps add up to 6 workers who started over and 9 who went back).
assert.deepEqual(
  restarts.restartTotals(rsRows, 'all'),
  { reached: 400, startedOver: '5 · 1%', wentBack: '8 · 2%', presses: 18 },
);
assert.deepEqual(restarts.restartTotals(rsRows, 'whatsapp'), { reached: 20, startedOver: '3 · 15%', wentBack: '2 · 10%', presses: 6 });
assert.deepEqual(restarts.restartTotals(rsRows, 'web'), { reached: 12, startedOver: '—', wentBack: '3 · 25%', presses: 5 });
assert.deepEqual(
  restarts.restartTotals([], 'all'),
  { reached: 0, startedOver: '0 · —', wentBack: '0 · —', presses: 0 },
  'a missing all-steps row reads as zeros; nobody at a step means no share',
);
assert.equal(restarts.restartsEmpty(rsRows, 'all'), false);
assert.equal(restarts.restartsEmpty(rsRows, 'web'), false);
assert.equal(restarts.restartsEmpty([], 'all'), true, 'no rows: the empty state');
assert.equal(
  restarts.restartsEmpty([{ weekStart: null, door: 'whatsapp', stepKey: 'legal.review', ...rsFig(40, 0, 0, 0, 0) }], 'whatsapp'),
  true,
  'steps reached but nobody pressed: the empty state',
);
assert.equal(
  restarts.restartsEmpty([{ weekStart: null, door: 'web', stepKey: 'profile.name', ...rsFig(3, 1, 1, 0, 0) }], 'web'),
  true,
  'the web door ignores start-over presses',
);

// By week: every week of the window, oldest first, from the week's all-steps
// row (workers distinct across steps: 3 started over in the week of Oct 5,
// though the steps add up to 4 and the biggest step has 2); a week with no row
// is 0; weeks outside the window are ignored.
assert.deepEqual(restarts.restartWeeks(rsRows, 'all', 4, rsNow), [
  { weekStart: rsW0, restartWorkers: 0, backWorkers: 0 },
  { weekStart: rsW1, restartWorkers: 1, backWorkers: 3 },
  { weekStart: rsW2, restartWorkers: 0, backWorkers: 0 },
  { weekStart: rsW3, restartWorkers: 3, backWorkers: 3 },
]);
assert.deepEqual(
  restarts.restartWeeks(rsRows, 'web', 4, rsNow).map((week) => [week.restartWorkers, week.backWorkers]),
  [[0, 0], [0, 0], [0, 3], [0, 0]],
  'the web door counts workers who went back only',
);
assert.equal(restarts.restartWeeks([], 'all', 12, rsNow).length, 12);

// Operator resets.
const rsResetRow = {
  week_start: new Date('2026-07-27T00:00:00.000Z'), reason: 'cutover: reset all workers into onboarding v2',
  workers: '412', resets: '415', bulk: true, run_started_at: new Date('2026-07-29T14:05:00.000Z'),
};
// workers and resets differ, so a swap of the two columns fails here.
assert.deepEqual(analytics.mapOperatorResetRow(rsResetRow), {
  weekStart: '2026-07-27T00:00:00.000Z', reason: 'cutover: reset all workers into onboarding v2',
  workers: 412, resets: 415, bulk: true, runStartedAt: '2026-07-29T14:05:00.000Z',
});
assert.equal(
  analytics.mapOperatorResetRow({ ...rsResetRow, week_start: new Date(rsW2), reason: '(no reason)', workers: '2', resets: '3', bulk: false, run_started_at: null }).runStartedAt,
  null,
  'a counted row has no run time',
);
const rsResets = [
  { weekStart: rsW2, reason: 'QA retest', workers: 2, resets: 3, bulk: false, runStartedAt: null },
  { weekStart: '2026-07-27T00:00:00.000Z', reason: 'QA batch', workers: 15, resets: 15, bulk: true, runStartedAt: '2026-08-02T09:00:00.000Z' },
  { weekStart: rsW3, reason: 'stuck on voice note ••••', workers: 2, resets: 4, bulk: false, runStartedAt: null },
  { weekStart: rsW3, reason: 'QA retest', workers: 1, resets: 3, bulk: false, runStartedAt: null },
  { weekStart: '2026-07-27T00:00:00.000Z', reason: 'cutover: reset all workers into onboarding v2', workers: 412, resets: 412, bulk: true, runStartedAt: '2026-07-29T14:05:00.000Z' },
  { weekStart: rsW3, reason: '(no reason)', workers: 3, resets: 3, bulk: false, runStartedAt: null },
];
assert.deepEqual(
  restarts.resetTableRows(rsResets, rsNow).map((row) => [row.label, row.current, row.reason, row.workers, row.resets]),
  [
    ['Week of Oct 5', true, 'stuck on voice note ••••', 2, 4],
    ['Week of Oct 5', true, '(no reason)', 3, 3],
    ['Week of Oct 5', true, 'QA retest', 1, 3],
    ['Week of Sep 28', false, 'QA retest', 2, 3],
  ],
  'bulk runs left out; newest week first, then most resets, then reason',
);
assert.deepEqual(restarts.resetTableRows(rsResets.filter((row) => row.bulk), rsNow), [], 'only bulk runs: the table is empty');
assert.equal(
  restarts.bulkRunsNote(rsResets, rsNow),
  "Left out: 2 bulk runs ('cutover: reset all workers into onboarding v2', 412 workers, Jul 29; 'QA batch', 15 workers, Aug 2).",
  'oldest run first',
);
assert.equal(
  restarts.bulkRunsNote(rsResets.filter((row) => row.reason !== 'QA batch'), rsNow),
  "Left out: 1 bulk run ('cutover: reset all workers into onboarding v2', 412 workers, Jul 29).",
);
assert.equal(
  restarts.bulkRunsNote([{ ...rsResets[4], workers: 1204 }], new Date('2027-01-06T12:00:00.000Z')),
  "Left out: 1 bulk run ('cutover: reset all workers into onboarding v2', 1,204 workers, Jul 29, 2026).",
  'a run from another year shows the year',
);
assert.equal(
  restarts.bulkRunsNote([{ ...rsResets[4], runStartedAt: '2026-07-29T23:30:00.000Z' }], rsNow),
  "Left out: 1 bulk run ('cutover: reset all workers into onboarding v2', 412 workers, Jul 29).",
  'the run date is the UTC day',
);
assert.equal(
  restarts.bulkRunsNote([{ ...rsResets[4], runStartedAt: '2026-07-30T00:30:00.000Z' }], rsNow),
  "Left out: 1 bulk run ('cutover: reset all workers into onboarding v2', 412 workers, Jul 30).",
  'just after midnight UTC is already the next day',
);
assert.equal(
  restarts.bulkRunsNote([{ ...rsResets[4], runStartedAt: '2027-01-01T00:30:00.000Z' }], new Date('2027-01-06T12:00:00.000Z')),
  "Left out: 1 bulk run ('cutover: reset all workers into onboarding v2', 412 workers, Jan 1).",
  'the year is the UTC year: just after New Year UTC is already the current year',
);
assert.equal(restarts.bulkRunsNote(rsResets.filter((row) => !row.bulk), rsNow), null, 'no bulk runs, no note');

// Applicant digest.
assert.deepEqual(
  analytics.mapDigestAdoptionRow({ employers: '280', digest_on: '34', digest_on_with_email: '29' }),
  { employers: 280, digestOn: 34, digestOnWithEmail: 29 },
);
for (const [employers, digestOn, digestOnWithEmail, line] of [
  [280, 34, 29, 'Digest on for 12% of employers (34 of 280) · 29 of them have an email address'],
  [0, 0, 0, 'Digest on for — of employers (0 of 0)'],
  [280, 0, 0, 'Digest on for 0% of employers (0 of 280)'],
  [300, 1, 1, 'Digest on for <1% of employers (1 of 300) · 1 of them has an email address'],
  [1200, 1199, 0, 'Digest on for >99% of employers (1,199 of 1,200) · 0 of them have an email address'],
  [5, 5, 5, 'Digest on for 100% of employers (5 of 5) · 5 of them have an email address'],
]) {
  assert.equal(digest.adoptionLine({ employers, digestOn, digestOnWithEmail }), line, `adoptionLine(${digestOn} of ${employers})`);
}
assert.deepEqual(
  analytics.mapDigestSendsRow({
    week_start: new Date(rsW2), emailed: '13', sent: '7', failed: '1', unknown: '2', in_progress: '3', employers_reached: '4',
  }),
  { weekStart: rsW2, emailed: 13, sent: 7, failed: 1, unknown: 2, inProgress: 3, employersReached: 4 },
);
assert.equal(
  analytics.mapDigestSendsRow({ week_start: null, emailed: '0', sent: '0', failed: '0', unknown: '0', in_progress: '0', employers_reached: '0' }).weekStart,
  null,
  'the window row keeps its NULL week',
);
const dgFig = (emailed, sent, failed, unknown, inProgress, employersReached) =>
  ({ emailed, sent, failed, unknown, inProgress, employersReached });
const dgSplit = digest.splitDigestSends([
  { weekStart: rsW3, ...dgFig(4, 2, 0, 0, 2, 2) },
  { weekStart: null, ...dgFig(16, 12, 1, 1, 2, 5) },
  { weekStart: rsW1, ...dgFig(3, 3, 0, 0, 0, 3) },
  { weekStart: rsW0, ...dgFig(0, 0, 0, 0, 0, 0) },
  { weekStart: rsW2, ...dgFig(9, 7, 1, 1, 0, 4) },
]);
assert.deepEqual(dgSplit.weekly.map((week) => week.weekStart), [rsW0, rsW1, rsW2, rsW3], 'every week, oldest first');
assert.equal('weekStart' in dgSplit.window, false);
assert.deepEqual(
  dgSplit.window,
  dgFig(16, 12, 1, 1, 2, 5),
  'the total row is the SQL window row: employers reached is distinct across the weeks (5, not 9)',
);
assert.deepEqual(digest.splitDigestSends([]), { weekly: [], window: dgFig(0, 0, 0, 0, 0, 0) }, 'a missing window row reads as zero');
assert.deepEqual(
  digest.digestTableRows(dgSplit, rsNow).map((row) => [row.label, row.current, row.emailed, row.employersReached]),
  [
    ['Week of Oct 5', true, 4, 2],
    ['Week of Sep 28', false, 9, 4],
    ['Week of Sep 21', false, 3, 3],
    ['Week of Sep 14', false, 0, 0],
  ],
  'newest first; the current week is so far',
);
assert.equal(digest.digestEmpty(dgSplit), false);
assert.equal(digest.digestEmpty(digest.splitDigestSends([{ weekStart: rsW3, ...dgFig(0, 0, 0, 0, 0, 0) }, { weekStart: null, ...dgFig(0, 0, 0, 0, 0, 0) }])), true, 'nothing emailed: the empty state');

// ==== S28 FE-4: view helpers for the K3.3 panels (FE-owned section) ====
// Fixed clock: Wednesday 2026-10-14 12:00 UTC; the current week starts Monday 2026-10-12.
const fe4Now = new Date('2026-10-14T12:00:00.000Z');
const fe4W = ['2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-12T00:00:00.000Z'];

// #14: starters, then steps in onboarding order; a branch step says so and is never a drop.
const fe4Steps = funnel.onboardingStepStages({
  started: 1000,
  steps: [
    { stepKey: 'identity.verify_otp', label: 'Phone code', order: 2, branch: false, reached: 700, ofStarted: 70, ofPrevious: 74.5 },
    { stepKey: 'start.choose_language', label: 'Language', order: 1, branch: false, reached: 940, ofStarted: 94, ofPrevious: 94 },
    { stepKey: 'profile.custom_trade', label: 'Custom trade', order: 3, branch: true, reached: 40, ofStarted: 4, ofPrevious: null },
    { stepKey: 'profile.experience', label: 'Experience', order: 4, branch: false, reached: 650, ofStarted: 65, ofPrevious: null },
  ],
});
assert.deepEqual(fe4Steps.map((s) => [s.label, s.count]), [
  ['Started', 1000], ['Language', 940], ['Phone code', 700], ['Custom trade (some workers only)', 40], ['Experience', 650],
]);
assert.equal(funnel.onboardingCaption(fe4Steps), '1,000 workers started in the range. Biggest drop: Phone code (−24 points).', 'the custom-trade branch (−66) is not a drop');
assert.equal(funnel.onboardingCaption([{ key: 'started', label: 'Started', count: 0 }]), '0 workers started in the range.');
assert.equal(funnel.onboardingCaption([{ key: 'started', label: 'Started', count: 1 }, { key: 'a', label: 'A', count: 1 }]), '1 worker started in the range.', 'no drop: no claim');

// #15
const fe4Identity = {
  challenges: 500, reachedCode: 480, verified: 320, lockedOnce: 12, expiredUnused: 0,
  attempts: { zero: 300, one: 120, two: 50, threePlus: 30 },
  medianMinutesToVerify: 4.2, p75MinutesToVerify: 120, timingsSince: '2026-10-05T00:00:00.000Z',
};
assert.deepEqual(funnel.identityStages(fe4Identity).map((s) => s.count), [500, 480, 320]);
assert.deepEqual(funnel.identityAttemptValues(fe4Identity), [300, 120, 50, 30]);
assert.deepEqual(funnel.identityOutcomes(fe4Identity), [
  { label: 'Locked at least once', value: '12 · 2%' },
  { label: 'Expired unused', value: '0 · 0%' },
]);
assert.equal(funnel.identityTimingText(fe4Identity), 'Median 4 min to verify · 75% within 2.0 h · timings since Oct 5');
assert.equal(funnel.identityTimingText({ ...fe4Identity, medianMinutesToVerify: null }), 'No verification timings in these weeks.');

// #12: the WhatsApp door's cohort funnel, whatever door the page shows.
const fe4Cohorts = [
  { cohortWeek: fe4W[2], door: 'whatsapp', started: 10, codeRequested: 9, verified: 7, acceptedTerms: 6, finishedProfile: 5, ready: 4, declined: 0, inProgress: 1, abandoned: 0 },
  { cohortWeek: fe4W[2], door: 'web', started: 99, codeRequested: 99, verified: 99, acceptedTerms: 99, finishedProfile: 99, ready: 99, declined: 0, inProgress: 0, abandoned: 0 },
];
assert.deepEqual(funnel.whatsappStages(fe4Cohorts, 8, fe4Now).map((s) => [s.label, s.count]), [
  ['Started', 10], ['Requested a code', 9], ['Verified', 7], ['Accepted terms', 6], ['Finished profile', 5], ['Ready', 4],
]);

// #21
const fe4Ref = [
  { weekStart: fe4W[1], partial: false, opens: 50, applyIntents: 20, claims: 10, applications: 6, hires: 1 },
  { weekStart: fe4W[2], partial: true, opens: 19, applyIntents: 5, claims: 2, applications: 1, hires: 0 },
];
assert.deepEqual(funnel.referralStages(fe4Ref).map((s) => s.count), [69, 25, 12, 7, 1]);
assert.deepEqual(funnel.referralStages([]).map((s) => s.count), [0, 0, 0, 0, 0]);
assert.equal(funnel.referralNote(null), `Kept as daily snapshots, so history survives link expiry. Snapshots start with ${analyticsFormat.ANALYTICS_RELEASE_LABEL}.`);
assert.equal(funnel.referralNote(fe4W[0]), 'Kept as daily snapshots, so history survives link expiry. Snapshots since Sep 28.');

// #17: public opens have history; signed-in views only once collecting.
const fe4Views = [
  { weekStart: fe4W[2], partial: true, publicOpens: 0, publicApplications: 0, workerViews: 3, workerViewApplications: 1 },
  { weekStart: fe4W[1], partial: false, publicOpens: 200, publicApplications: 1, workerViews: 0, workerViewApplications: 0 },
];
const fe4ViewChart = funnel.jobViewChart({ weeks: fe4Views, collectingSince: null });
assert.deepEqual(fe4ViewChart.labels, ['Oct 5', 'Oct 12'], 'oldest first');
assert.equal(fe4ViewChart.partialLast, true);
assert.deepEqual(fe4ViewChart.series[0].values, [0.5, null], 'no public opens: a gap, never 0%');
assert.deepEqual(fe4ViewChart.series[1].values, [null, null], 'signed-in views are not shown before they are collected');
assert.equal(fe4ViewChart.empty, false);
assert.deepEqual(funnel.jobViewChart({ weeks: fe4Views, collectingSince: fe4W[2] }).series[1].values, [null, 33.3]);
assert.equal(funnel.jobViewChart({ weeks: [], collectingSince: null }).empty, true, 'nothing at all: the collecting-since panel');

// #20
const fe4Match = funnel.matchChart({
  weeks: [
    { weekStart: fe4W[2], partial: true, channel: 'whatsapp', shown: 10, appliedWithin7d: 0 },
    { weekStart: fe4W[1], partial: false, channel: 'web', shown: 3, appliedWithin7d: 1 },
  ],
  collectingSince: fe4W[1],
});
assert.deepEqual(fe4Match.labels, ['Oct 5', 'Oct 12']);
assert.deepEqual(fe4Match.series.map((s) => s.values), [[33.3, null], [null, 0]]);
assert.equal(fe4Match.partialLast, true);
assert.equal(funnel.matchChart({ weeks: [], collectingSince: null }).empty, true);

// #16: six sources, fixed order and colours.
const fe4Acq = funnel.acquisitionChart({
  weeks: [{ weekStart: fe4W[2], partial: true, total: 3, bySource: { shared_link: 1, campaign_tag: 0, referral: 2, direct: 0, whatsapp_entry: 0, unknown: 0 } }],
  collectingSince: fe4W[2],
});
assert.deepEqual(fe4Acq.series.map((s) => [s.key, s.color, s.values[0]]), [
  ['shared_link', 'chart-1', 1], ['campaign_tag', 'chart-2', 0], ['referral', 'chart-3', 2],
  ['direct', 'chart-4', 0], ['whatsapp_entry', 'chart-5', 0], ['unknown', 'chart-6', 0],
]);
assert.equal(funnel.acquisitionChart({ weeks: [], collectingSince: null }).empty, true);

// The cohort-table wash is a token mix now (no raw colour).
assert.equal(funnel.shareShade(0, 0), undefined);
assert.equal(funnel.shareShade(0, 10), 'color-mix(in srgb, var(--chart-1) 6%, transparent)');
assert.equal(funnel.shareShade(10, 10), 'color-mix(in srgb, var(--chart-1) 36%, transparent)');
assert.equal(funnel.funnelsHref(13, 'web'), '/analytics/funnels?weeks=13&door=web');

// #2
const fe4Paying = [
  { weekStart: fe4W[2], partial: true, employers: 210, paying: 20, newPaying: 2, churned: 0 },
  { weekStart: fe4W[1], partial: false, employers: 200, paying: 19, newPaying: 3, churned: 1 },
];
assert.deepEqual(health.payingChart({ weeks: fe4Paying, approximateBefore: null }), {
  labels: ['Oct 5', 'Oct 12'], partialLast: true,
  series: [{ key: 'newPaying', label: 'New paying employers', color: 'chart-1', values: [3, 2] }],
});
assert.deepEqual(health.payingHeadline(fe4Paying), { value: '10%', note: 'of employers are paying (20 of 210)' });
assert.deepEqual(health.payingHeadline([]), { value: '—', note: 'of employers are paying' });
assert.equal(health.approximateNote(null), null);
assert.equal(health.approximateNote(fe4W[0]), 'Weeks before Sep 28 are approximate: subscription history starts then, so earlier churn is under-counted.');

// #18, #3, #8, #4
const fe4Tpl = health.templateReuseChart({ weeks: [{ weekStart: fe4W[2], partial: true, jobs: 0, fromTemplate: 0, employersUsingTemplates: 0, templatesSaved: 0 }], collectingSince: fe4W[2] });
assert.deepEqual(fe4Tpl.series[0].values, [null], 'no jobs: no share');
assert.equal(fe4Tpl.empty, false);
assert.equal(health.templateReuseChart({ weeks: [], collectingSince: null }).empty, true);
const fe4Weekly = [fe4W[2], fe4W[1]].map((weekStart, i) => ({
  weekStart, applications: 0, answered: 0, answeredUntimed: 0, unanswered7d: 0, applicationsDue: 0,
  firstResponseP50Hours: i === 0 ? null : 19.04, firstResponseP75Hours: null, workerTurns: 0, turnsUnanswered7d: 0, turnsDue: 0,
  replyP50Hours: 2.5, replyP75Hours: null, hires: i + 1, hiresApproximate: 0, timeToHireP50Days: null, timeToHireP75Days: null,
}));
assert.deepEqual(health.hiresChart(fe4Weekly, fe4Now), {
  labels: ['Oct 5', 'Oct 12'], partialLast: true, series: [{ key: 'hires', label: 'Hires', color: 'chart-1', values: [2, 1] }],
});
assert.deepEqual(health.responseChart(fe4Weekly, fe4Now).series.map((s) => s.values), [[19.04, null], [2.5, 2.5]], 'no median: a gap, never 0');
assert.equal(health.staleNote(1), 'open job with no employer action');
assert.equal(health.staleNote(6), 'open jobs with no employer action');
assert.equal(health.employersHref(13), '/analytics/employers?weeks=13', 'the default stale window stays out of the link');
assert.equal(health.employersHref(26, 30), '/analytics/employers?weeks=26&stale=30');

// Ops: lanes keep one chart token each, in LANES order.
assert.deepEqual(ops.LANES.map((lane) => ops.LANE_CHART_COLORS[lane.id]), ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6']);
assert.equal(ops.wholePercent(1, 1000), '<1%', 'wholePercent is still exported from ops-health');

// #6
const fe4Ages = ops.caseAgeChart([
  { label: '>3d', waitingOnUs: 1, waitingOnWorker: 2 },
  { label: '<1h', waitingOnUs: 3, waitingOnWorker: 0 },
]);
assert.deepEqual(fe4Ages.labels, ['Under 1 hour', '1 to 4 hours', '4 to 24 hours', '1 to 3 days', 'Over 3 days']);
assert.deepEqual(fe4Ages.series.map((s) => s.values), [[3, 0, 0, 0, 1], [0, 0, 0, 0, 2]], 'a missing bucket is an empty bucket');
assert.equal(fe4Ages.total, 6);
const fe4Res = ops.resolutionChart([
  { weekStart: fe4W[2], partial: true, resolved: 0, medianHours: null, p75Hours: null },
  { weekStart: fe4W[1], partial: false, resolved: 4, medianHours: 3.5, p75Hours: 9 },
]);
assert.deepEqual(fe4Res.series.map((s) => s.values), [[3.5, null], [9, null]]);
assert.deepEqual(fe4Res.resolved, [4, 0]);
assert.equal(fe4Res.partialLast, true);

// #5
const fe4Resets = ops.resetReasonChart([
  { source: 'operator_reset', reasonLabel: 'Operator reset', count: 5 },
  { source: 'lockout_reset', reasonLabel: 'Codes not arriving', count: 11 },
  { source: 'lockout_reset', reasonLabel: 'Typo in details', count: 5 },
]);
assert.deepEqual(fe4Resets, { labels: ['Codes not arriving', 'Operator reset', 'Typo in details'], values: [11, 5, 5], total: 21 });
assert.equal(ops.resetValueText(21)(11), '11 · 52%');
assert.equal(ops.resetValueText(0)(0), '0 · —');

// #10
assert.equal(ops.extractionAxisMin([94, null, 80]), 80);
assert.equal(ops.extractionAxisMin([94, 79.9]), 0, 'a week below 80% keeps the axis at 0');
assert.equal(ops.extractionAxisMin([null]), 0);
const fe4ZeroVoice = {
  processed: 0, failed: 0, failedTranscribe: 0, failedEmptyTranscript: 0, failedAudioRead: 0, failedModelCall: 0,
  failedBadJson: 0, failedBadShape: 0, failedPipelineError: 0, failedUnrecorded: 0, usable: 0, fullNameFound: 0,
  cityFound: 0, mainTradeFound: 0, mainTradeOtherDue: 0, mainTradeOtherFound: 0, yearsExperienceFound: 0,
  hasTransportationFound: 0, availabilityFound: 0,
};
const fe4Voice = { weekly: [{ ...fe4ZeroVoice, weekStart: fe4W[2], processed: 3, usable: 3 }], window: fe4ZeroVoice, models: [] };
assert.deepEqual(ops.extractionChart(fe4Voice, fe4Now), { labels: ['Oct 12'], partialLast: true, values: [100], yMin: 80 });

// Pipelines strip (#9, #11, #19)
assert.deepEqual(ops.billingTile({ stuckReceived: 1, failedNow: 2, failedLast24h: 5, unresolvedOlder: 4, oldestStuckAt: null }), { value: '5', hint: '4 dead-lettered in the last 14 days' });
const fe4Backlog = [{ lane: 'reply', openUnder1h: 2, open1To24h: 1, open24To48h: 0, stuck: 0, oldestStuckAt: null }];
assert.deepEqual(
  ops.queueTile(fe4Backlog, { queues: [{ label: 'WhatsApp inbound', visible: null, inFlight: null, unavailable: true }], totalVisible: null }),
  { value: '3 · —', hint: "Dead-letter queues: Couldn't read right now" },
  'an unreadable queue never reads as zero',
);
assert.deepEqual(
  ops.queueTile(fe4Backlog, {
    queues: [{ label: 'WhatsApp inbound', visible: 2, inFlight: 0, unavailable: false }, { label: 'Billing webhooks', visible: null, inFlight: null, unavailable: true }],
    totalVisible: 2,
  }).hint,
  "Couldn't read right now: Billing webhooks",
);
assert.deepEqual(ops.queueTile([], { queues: [{ label: 'A', visible: 0, inFlight: 0, unavailable: false }], totalVisible: 0 }), { value: '0 · 0', hint: '1 dead-letter queue checked' });
assert.deepEqual(
  ops.rankingTile({ buckets: [], jobsOlderThan24h: 3, fallbackShare: 0.25, fallbackJobs: 1, rankedJobs: 4, jobsWithApplicationsButNoRanking: 2 }),
  { value: '3 jobs', hint: 'of 4 ranked · 25% by the fallback · 2 with applicants but no ranking' },
);
assert.equal(ops.rankingTile({ buckets: [], jobsOlderThan24h: 1, fallbackShare: null, fallbackJobs: 0, rankedJobs: 0, jobsWithApplicationsButNoRanking: 0 }).value, '1 job');

// #13
assert.deepEqual(digest.digestHeadline({ employers: 280, digestOn: 34, digestOnWithEmail: 29 }), { value: '10%', note: 'of employers get the digest (29 of 280)' });
assert.deepEqual(digest.digestHeadline({ employers: 0, digestOn: 0, digestOnWithEmail: 0 }).value, '—');
const fe4Sends = digest.splitDigestSends([
  { weekStart: fe4W[2], emailed: 1, sent: 1, failed: 0, unknown: 0, inProgress: 0, employersReached: 1 },
  { weekStart: fe4W[1], emailed: 5, sent: 4, failed: 1, unknown: 0, inProgress: 0, employersReached: 3 },
  { weekStart: null, emailed: 6, sent: 5, failed: 1, unknown: 0, inProgress: 0, employersReached: 3 },
]);
assert.deepEqual(digest.digestSendChart(fe4Sends, fe4Now), { labels: ['Oct 5', 'Oct 12'], partialLast: true, values: [4, 1] });

// The FunnelWeeks-typed helpers take the K3.0 range (8 / 13 / 26 weeks).
assert.equal(funnel.cohortWeekStarts(26, fe4Now).length, 26);
assert.equal(funnel.cohortWeekStarts(13, fe4Now).at(-1), fe4W[2]);
assert.equal(ops.opsHref(26), '/analytics/ops?weeks=26');
assert.equal(restarts.restartWeeks([], 'all', 13, fe4Now).length, 13);
// ==== end S28 FE-4 ====

// ==== Sprint 28, BE-3a: loader and mapper sections (K3.3 / K3.4) ====

// ---- #11 live dead-letter depth (getDlqDepth) ----
// The queues come from ADMIN_DLQ_QUEUES (labels and URLs, set by AdminStack);
// each is read in parallel with its own 1.5 s limit, and one failing queue is
// unavailable on its own, never a thrown page.
{
  const check = (globalThis.__adminCheck ??= {});
  const dlq = [
    { label: 'WhatsApp inbound', url: 'https://sqs.example.test/queue-a' },
    { label: 'Billing webhooks', url: 'https://sqs.example.test/queue-b' },
    { label: 'Trust extraction', url: 'https://sqs.example.test/queue-c' },
  ];
  const ATTRIBUTES = ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'];
  const answer = (visible, inFlight) => ({
    Attributes: { ApproximateNumberOfMessages: String(visible), ApproximateNumberOfMessagesNotVisible: String(inFlight) },
  });
  process.env.ADMIN_DLQ_QUEUES = JSON.stringify(dlq);

  // One queue refuses: that queue alone is unavailable; the total is unknown.
  check.sqs = {
    clients: [],
    sent: [],
    behavior: (command) => {
      if (command.input.QueueUrl.endsWith('queue-b')) {
        return Object.assign(new Error('not authorized on <queue-arn>'), { name: 'AccessDenied' });
      }
      return command.input.QueueUrl.endsWith('queue-a') ? answer(3, 1) : answer(0, 2);
    },
  };
  const { result: oneDown, lines } = await captureConsole(() => analytics.getDlqDepth());
  assert.deepEqual(oneDown, {
    queues: [
      { label: 'WhatsApp inbound', visible: 3, inFlight: 1, unavailable: false },
      { label: 'Billing webhooks', visible: null, inFlight: null, unavailable: true },
      { label: 'Trust extraction', visible: 0, inFlight: 2, unavailable: false },
    ],
    totalVisible: null,
  }, 'a refused queue is unavailable on its own and the total is unknown');
  assert.deepEqual(
    check.sqs.sent.map((sent) => sent.input),
    dlq.map((queue) => ({ QueueUrl: queue.url, AttributeNames: ATTRIBUTES })),
    'one read per listed queue, in order, for the two depth attributes only',
  );
  assert.ok(check.sqs.sent.every((sent) => sent.options?.abortSignal instanceof AbortSignal), 'every read carries an abort signal');
  const logged = JSON.stringify(lines.error);
  assert.match(logged, /AccessDenied/, 'the failure is logged by its error name');
  assert.doesNotMatch(logged, /queue-arn|example\.test/, 'never the error message or the queue address');

  // Every queue answers: the total is the sum of the visible messages.
  check.sqs = { clients: [], sent: [], behavior: (command) => (command.input.QueueUrl.endsWith('queue-b') ? answer(4, 0) : answer(1, 0)) };
  const allUp = await analytics.getDlqDepth();
  assert.deepEqual(allUp.queues.map((queue) => [queue.label, queue.visible, queue.unavailable]), [
    ['WhatsApp inbound', 1, false], ['Billing webhooks', 4, false], ['Trust extraction', 1, false],
  ]);
  assert.equal(allUp.totalVisible, 6);

  // An answer without the attributes is unavailable, never zero.
  check.sqs = { clients: [], sent: [], behavior: () => ({ Attributes: {} }) };
  const blank = await captureConsole(() => analytics.getDlqDepth());
  assert.deepEqual(blank.result.queues.map((queue) => queue.unavailable), [true, true, true]);
  assert.equal(blank.result.totalVisible, null);

  // Hanging queues give up after 1.5 s each, in parallel.
  check.sqs = { clients: [], sent: [], behavior: (command) => (command.input.QueueUrl.endsWith('queue-c') ? answer(2, 0) : 'hang') };
  const started = Date.now();
  const hung = await captureConsole(() => analytics.getDlqDepth());
  const elapsed = Date.now() - started;
  assert.deepEqual(hung.result.queues.map((queue) => [queue.label, queue.unavailable]), [
    ['WhatsApp inbound', true], ['Billing webhooks', true], ['Trust extraction', false],
  ]);
  assert.ok(elapsed >= 1400 && elapsed < 2800, `two hanging reads time out together after about 1.5 s (took ${elapsed} ms)`);

  // No list (local preview) or a malformed one: nothing to measure, no read.
  for (const value of [undefined, 'not json', '{"label":"x"}', '[{"label":"WhatsApp inbound"}]']) {
    if (value === undefined) delete process.env.ADMIN_DLQ_QUEUES;
    else process.env.ADMIN_DLQ_QUEUES = value;
    check.sqs = { clients: [], sent: [], behavior: () => answer(1, 1) };
    assert.deepEqual(await analytics.getDlqDepth(), { queues: [], totalVisible: null }, `ADMIN_DLQ_QUEUES=${value}`);
    assert.equal(check.sqs.sent.length, 0);
  }
  delete process.env.ADMIN_DLQ_QUEUES;
}

// ---- K3.4 system health (getSystemHealth) ----
// One statement (the 24 h / 7 day figures, the message backlog and the billing
// inbox), the dead-letter depth and SES bounces; each item's state follows the
// rules table, and any source that cannot be read makes its item unknown.
{
  const check = (globalThis.__adminCheck ??= {});
  // The Lambda runs in the main region; SES also sends from us-east-1.
  const savedRegion = process.env.AWS_REGION;
  process.env.AWS_REGION = 'us-east-2';
  const healthStatements = [];
  const healthRow = (o = {}) => ({
    whatsapp_failed_24h: '0', ai_finished_7d: '100', ai_usable_7d: '100',
    queued_over_1h: '0', stuck_messages: '0', billing_failed_24h: '0', ...o,
  });
  const healthPool = (row) => ({
    query: async (sql, params) => {
      healthStatements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (row instanceof Error) throw row;
      return { rows: [row] };
    },
  });
  const bounces = (values) => ({ MetricDataResults: [{ Id: 'bounces', Values: values }] });
  // The SES feedback dead-letter queue, set only when it exists (AdminStack).
  const FEEDBACK_URL = 'https://sqs.example.test/ses-feedback';
  // Sets every source, runs getSystemHealth, returns key -> [state, value].
  // `feedback`: undefined leaves the feedback queue unset; a number is its
  // depth; an Error is a failed read.
  async function healthOf({ row = healthRow(), dlq = [0, 0], cw = () => bounces([]), feedback } = {}) {
    check.pool = healthPool(row);
    process.env.ADMIN_DLQ_QUEUES = JSON.stringify(dlq.map((_, i) => ({ label: `Queue ${i}`, url: `https://sqs.example.test/q${i}` })));
    if (feedback === undefined) delete process.env.ADMIN_SES_FEEDBACK_DLQ_URL;
    else process.env.ADMIN_SES_FEEDBACK_DLQ_URL = FEEDBACK_URL;
    check.sqs = {
      clients: [], sent: [],
      behavior: (command) => {
        const visible = command.input.QueueUrl === FEEDBACK_URL ? feedback : dlq[Number(command.input.QueueUrl.slice(-1))];
        return visible instanceof Error ? visible
          : { Attributes: { ApproximateNumberOfMessages: String(visible), ApproximateNumberOfMessagesNotVisible: '0' } };
      },
    };
    check.metrics = { clients: [], sent: [], behavior: cw };
    const { result } = await captureConsole(() => analytics.getSystemHealth());
    delete process.env.ADMIN_DLQ_QUEUES;
    delete process.env.ADMIN_SES_FEEDBACK_DLQ_URL;
    assert.equal(result.windowLabel, 'last 24 hours');
    return Object.fromEntries(result.items.map((item) => [item.key, [item.state, item.value]]));
  }

  // Everything quiet: the six items, in order, with their labels.
  check.pool = healthPool(healthRow());
  check.metrics = { clients: [], sent: [], behavior: () => bounces([]) };
  const quiet = await captureConsole(() => analytics.getSystemHealth());
  assert.deepEqual(quiet.result.items.map((item) => [item.key, item.label]), [
    ['whatsapp_delivery', 'WhatsApp delivery'],
    ['message_backlog', 'Message backlog'],
    ['billing_webhooks', 'Billing webhooks'],
    ['email_bounces', 'Email bounces'],
    ['email_feedback', 'Email feedback'],
    ['ai_extraction', 'AI extraction'],
  ]);
  assert.equal(healthStatements.length, 1, 'one statement for every database figure');
  assert.match(healthStatements[0].sql, /FROM admin_analytics_system_health\(\) h/);
  assert.match(healthStatements[0].sql, /FROM admin_analytics_message_backlog\(\) m/);
  assert.match(healthStatements[0].sql, /CROSS JOIN admin_analytics_billing_inbox_now\(\) n/);
  assert.equal(healthStatements[0].params, undefined);

  const quietAll = await healthOf();
  assert.deepEqual(quietAll, {
    whatsapp_delivery: ['healthy', '0 failed sends'],
    message_backlog: ['healthy', '0 stuck · 0 queued over 1 h · 0 dead-lettered'],
    billing_webhooks: ['healthy', '0 failed events'],
    email_bounces: ['healthy', '0 bounces'],
    email_feedback: ['unknown', 'not configured'],
    ai_extraction: ['healthy', '100% usable (7 days)'],
  });

  // Email feedback: not configured without the queue, and then never
  // read; with it, empty is healthy, any message a problem, and a queue that
  // cannot be read is unknown.
  {
    await healthOf();
    assert.deepEqual(check.sqs.sent.map((sent) => sent.input.QueueUrl).filter((url) => url === FEEDBACK_URL), [], 'an unset queue is not read');
  }
  assert.deepEqual((await healthOf({ feedback: 0 })).email_feedback, ['healthy', '0 dead-lettered']);
  assert.deepEqual(check.sqs.sent.filter((sent) => sent.input.QueueUrl === FEEDBACK_URL).length, 1, 'the feedback queue is read once');
  assert.deepEqual((await healthOf({ feedback: 1 })).email_feedback, ['problem', '1 dead-lettered']);
  assert.deepEqual((await healthOf({ feedback: 1200 })).email_feedback, ['problem', '1,200 dead-lettered']);
  assert.deepEqual((await healthOf({ feedback: new Error('refused') })).email_feedback, ['unknown', 'unavailable']);
  // Its messages are its own: the message backlog counts the listed queues only.
  assert.deepEqual((await healthOf({ feedback: 4 })).message_backlog, ['healthy', '0 stuck · 0 queued over 1 h · 0 dead-lettered']);

  // WhatsApp delivery: 0 healthy, 1-4 watch, 5+ problem.
  for (const [failed, state, value] of [
    ['0', 'healthy', '0 failed sends'], ['1', 'watch', '1 failed send'], ['4', 'watch', '4 failed sends'],
    ['5', 'problem', '5 failed sends'], ['1200', 'problem', '1,200 failed sends'],
  ]) {
    assert.deepEqual((await healthOf({ row: healthRow({ whatsapp_failed_24h: failed }) })).whatsapp_delivery, [state, value], `failed ${failed}`);
  }

  // Message backlog: stuck or dead-lettered is a problem; only queued over an
  // hour is worth watching; nothing at all is healthy.
  assert.deepEqual((await healthOf({ row: healthRow({ queued_over_1h: '2' }) })).message_backlog,
    ['watch', '0 stuck · 2 queued over 1 h · 0 dead-lettered']);
  assert.deepEqual((await healthOf({ row: healthRow({ stuck_messages: '1' }) })).message_backlog,
    ['problem', '1 stuck · 0 queued over 1 h · 0 dead-lettered']);
  assert.deepEqual((await healthOf({ dlq: [0, 3] })).message_backlog,
    ['problem', '0 stuck · 0 queued over 1 h · 3 dead-lettered']);
  assert.deepEqual((await healthOf({ row: healthRow({ queued_over_1h: '5' }), dlq: [1, 0] })).message_backlog,
    ['problem', '0 stuck · 5 queued over 1 h · 1 dead-lettered'], 'dead-lettered outranks queued');
  assert.deepEqual((await healthOf({ dlq: [0, new Error('refused')] })).message_backlog,
    ['unknown', '0 stuck · 0 queued over 1 h · — dead-lettered'], 'a queue that cannot be read: unknown');

  // Billing webhooks: 0 healthy, 1+ problem.
  assert.deepEqual((await healthOf({ row: healthRow({ billing_failed_24h: '1' }) })).billing_webhooks, ['problem', '1 failed event']);
  assert.deepEqual((await healthOf({ row: healthRow({ billing_failed_24h: '3' }) })).billing_webhooks, ['problem', '3 failed events']);

  // Email bounces: 0 healthy, 1-2 watch, 3+ problem, summed over both regions;
  // a region with no datapoint counts 0; a region that cannot be read: unknown.
  for (const [values, state, value] of [
    [[], 'healthy', '0 bounces'], [[1], 'watch', '1 bounce'], [[1, 1], 'watch', '2 bounces'], [[2, 1], 'problem', '3 bounces'],
  ]) {
    assert.deepEqual((await healthOf({ cw: (command, region) => (region === 'us-east-1' ? bounces(values) : { MetricDataResults: [] }) })).email_bounces,
      [state, value], `bounces ${values}`);
  }
  assert.deepEqual((await healthOf({ cw: () => bounces([1]) })).email_bounces, ['watch', '2 bounces'], 'one bounce in each region');
  assert.deepEqual((await healthOf({ cw: (command, region) => (region === 'us-east-1' ? new Error('throttled') : bounces([])) })).email_bounces,
    ['unknown', 'unavailable']);
  const metricReads = check.metrics.sent;
  assert.deepEqual([...new Set(metricReads.map((sent) => sent.region))].sort(), ['us-east-1', 'us-east-2'], 'both SES regions are read');
  for (const sent of metricReads) {
    assert.deepEqual(sent.input.MetricDataQueries.map((q) => [q.MetricStat.Metric.Namespace, q.MetricStat.Metric.MetricName, q.MetricStat.Stat]),
      [['AWS/SES', 'Bounce', 'Sum']]);
    assert.equal(sent.input.EndTime.getTime() - sent.input.StartTime.getTime(), 24 * 60 * 60 * 1000, 'the last 24 hours');
    assert.ok(sent.options?.abortSignal instanceof AbortSignal);
  }

  // AI extraction: usable share over 7 days; 95% and up healthy, 85% up to 95%
  // watch, under 85% a problem. The value never rounds up into a better band.
  for (const [usable, finished, state, value] of [
    ['95', '100', 'healthy', '95% usable (7 days)'],
    ['949', '1000', 'watch', '94% usable (7 days)'],
    ['85', '100', 'watch', '85% usable (7 days)'],
    ['849', '1000', 'problem', '84% usable (7 days)'],
    ['0', '3', 'problem', '0% usable (7 days)'],
    ['0', '0', 'healthy', 'no voice notes in 7 days'],
  ]) {
    assert.deepEqual((await healthOf({ row: healthRow({ ai_usable_7d: usable, ai_finished_7d: finished }) })).ai_extraction,
      [state, value], `${usable} of ${finished}`);
  }

  // The database cannot be read: its four items are unknown, the AWS ones stand.
  const dbDown = await healthOf({ row: new Error('connection refused') });
  assert.deepEqual(dbDown, {
    whatsapp_delivery: ['unknown', 'unavailable'],
    message_backlog: ['unknown', '— stuck · — queued over 1 h · 0 dead-lettered'],
    billing_webhooks: ['unknown', 'unavailable'],
    email_bounces: ['healthy', '0 bounces'],
    email_feedback: ['unknown', 'not configured'],
    ai_extraction: ['unknown', 'unavailable'],
  });
  if (savedRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = savedRegion;
}

// ---- K3.3 #16, #17, #18, #20, #21 (migration 124's definers, BE-3b) ----
// Each loader runs `SELECT * FROM <fn>($1)` once with the weeks. The rows are
// the pg shapes BE-3b posted: BIGINT counts as strings, timestamps as Dates,
// partial as a boolean, the "since" column repeated on every row.
{
  const check = (globalThis.__adminCheck ??= {});
  // A pool that answers every statement with `rows` and records it.
  function capturePool(rows) {
    const sent = [];
    check.pool = {
      query: async (sql, params) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rows };
      },
    };
    return sent;
  }
  const d = (iso) => new Date(iso);

  // #16 acquisition: every source mapped; collectingSince from the first row.
  const acquisitionRows = [
    { week_start: d('2026-10-05T00:00:00.000Z'), partial: false,
      from_shared_link: '0', from_campaign_tag: '0', from_referral: '0', from_direct: '0',
      from_whatsapp_entry: '0', from_unknown: '0', total: '0', collecting_since: d('2026-10-13T15:04:05.123Z') },
    { week_start: d('2026-10-12T00:00:00.000Z'), partial: true,
      from_shared_link: '4', from_campaign_tag: '1', from_referral: '5', from_direct: '2',
      from_whatsapp_entry: '3', from_unknown: '6', total: '21', collecting_since: d('2026-10-13T15:04:05.123Z') },
  ];
  let sent = capturePool(acquisitionRows);
  assert.deepEqual(await analytics.getAcquisition(2), {
    weeks: [
      { weekStart: '2026-10-05T00:00:00.000Z', partial: false, total: 0,
        bySource: { shared_link: 0, campaign_tag: 0, referral: 0, direct: 0, whatsapp_entry: 0, unknown: 0 } },
      { weekStart: '2026-10-12T00:00:00.000Z', partial: true, total: 21,
        bySource: { shared_link: 4, campaign_tag: 1, referral: 5, direct: 2, whatsapp_entry: 3, unknown: 6 } },
    ],
    collectingSince: '2026-10-13T15:04:05.123Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_acquisition($1)', params: [2] }]);
  capturePool(acquisitionRows.map((row) => ({ ...row, collecting_since: null })));
  assert.equal((await analytics.getAcquisition(2)).collectingSince, null, 'no signup source stored yet');
  capturePool([]);
  assert.deepEqual(await analytics.getAcquisition(8), { weeks: [], collectingSince: null });

  // #17 job views.
  sent = capturePool([{ week_start: d('2026-10-12T00:00:00.000Z'), partial: true,
    public_opens: '40', public_applications: '3', worker_views: '12', worker_view_applications: '2',
    collecting_since: d('2026-10-13T15:00:00.000Z') }]);
  assert.deepEqual(await analytics.getJobViewFunnel(1), {
    weeks: [{ weekStart: '2026-10-12T00:00:00.000Z', partial: true, publicOpens: 40, publicApplications: 3, workerViews: 12, workerViewApplications: 2 }],
    collectingSince: '2026-10-13T15:00:00.000Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_job_views($1)', params: [1] }]);

  // #18 template reuse, no template use yet.
  sent = capturePool([{ week_start: d('2026-10-12T00:00:00.000Z'), partial: true,
    jobs: '5', from_template: '0', employers_using_templates: '0', templates_saved: '1', collecting_since: null }]);
  assert.deepEqual(await analytics.getTemplateReuse(13), {
    weeks: [{ weekStart: '2026-10-12T00:00:00.000Z', partial: true, jobs: 5, fromTemplate: 0, employersUsingTemplates: 0, templatesSaved: 1 }],
    collectingSince: null,
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_template_reuse($1)', params: [13] }]);

  // #20 match to apply: two channels per week, as returned.
  const matchRows = [
    { week_start: d('2026-10-12T00:00:00.000Z'), partial: true, channel: 'web',
      shown: '30', applied_within_7d: '4', collecting_since: d('2026-10-13T15:04:05.123Z') },
    { week_start: d('2026-10-12T00:00:00.000Z'), partial: true, channel: 'whatsapp',
      shown: '0', applied_within_7d: '0', collecting_since: d('2026-10-13T15:04:05.123Z') },
  ];
  sent = capturePool(matchRows);
  assert.deepEqual(await analytics.getMatchToApply(26), {
    weeks: [
      { weekStart: '2026-10-12T00:00:00.000Z', partial: true, channel: 'web', shown: 30, appliedWithin7d: 4 },
      { weekStart: '2026-10-12T00:00:00.000Z', partial: true, channel: 'whatsapp', shown: 0, appliedWithin7d: 0 },
    ],
    collectingSince: '2026-10-13T15:04:05.123Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_match_to_apply($1)', params: [26] }]);
  capturePool([{ ...matchRows[0], channel: 'sms' }]);
  await assert.rejects(analytics.getMatchToApply(1), /Unexpected match channel: sms/, 'an unknown channel is an error, never a mislabelled row');

  // #21 referral funnel.
  sent = capturePool([{ week_start: d('2026-10-12T00:00:00.000Z'), partial: true,
    opens: '9', apply_intents: '2', claims: '1', applications: '1', hires: '0',
    snapshots_since: d('2026-10-06T00:00:00.000Z') }]);
  assert.deepEqual(await analytics.getReferralFunnel(8), {
    weeks: [{ weekStart: '2026-10-12T00:00:00.000Z', partial: true, opens: 9, applyIntents: 2, claims: 1, applications: 1, hires: 0 }],
    snapshotsSince: '2026-10-06T00:00:00.000Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_referral_funnel($1)', params: [8] }]);
  capturePool([]);
  assert.deepEqual(await analytics.getReferralFunnel(8), { weeks: [], snapshotsSince: null });
}

// ---- K3.3 #2, #5, #6, #14, #15, #19 (migration 123's definers) ----
// pg shapes: BIGINT counts and NUMERIC medians as strings, timestamps as
// Dates, NULL where there is nothing to measure. Shares are percents 0-100,
// unrounded, null on a zero denominator.
{
  const check = (globalThis.__adminCheck ??= {});
  function capturePool(rows) {
    const sent = [];
    check.pool = {
      query: async (sql, params) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rows };
      },
    };
    return sent;
  }
  const d = (iso) => new Date(iso);

  // #2 paying employers by week; approximateBefore from the first row.
  let sent = capturePool([
    { week_start: d('2026-10-05T00:00:00.000Z'), partial: false, employers: '40', paying: '6', new_paying: '2', churned: '1',
      approximate_before: d('2026-10-02T09:30:00.000Z') },
    { week_start: d('2026-10-12T00:00:00.000Z'), partial: true, employers: '42', paying: '7', new_paying: '1', churned: '0',
      approximate_before: d('2026-10-02T09:30:00.000Z') },
  ]);
  assert.deepEqual(await analytics.getPayingWeekly(2), {
    weeks: [
      { weekStart: '2026-10-05T00:00:00.000Z', partial: false, employers: 40, paying: 6, newPaying: 2, churned: 1 },
      { weekStart: '2026-10-12T00:00:00.000Z', partial: true, employers: 42, paying: 7, newPaying: 1, churned: 0 },
    ],
    approximateBefore: '2026-10-02T09:30:00.000Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_paying_weekly($1)', params: [2] }]);
  capturePool([{ week_start: d('2026-10-12T00:00:00.000Z'), partial: true, employers: '0', paying: '0', new_paying: '0', churned: '0', approximate_before: null }]);
  assert.equal((await analytics.getPayingWeekly(1)).approximateBefore, null, 'no live status change yet');

  // #5 resets by reason: the reset form's labels (without its hint), then operator resets.
  sent = capturePool([
    { source: 'lockout_reset', reason_code: 'codes_not_arriving', resets: '3' },
    { source: 'lockout_reset', reason_code: 'worker_confused', resets: '0' },
    { source: 'lockout_reset', reason_code: 'typo_in_details', resets: '1' },
    { source: 'lockout_reset', reason_code: 'identity_confirmed_elsewhere', resets: '0' },
    { source: 'lockout_reset', reason_code: 'other', resets: '2' },
    { source: 'operator_reset', reason_code: null, resets: '5' },
  ]);
  assert.deepEqual(await analytics.getResetReasons(30), [
    { source: 'lockout_reset', reasonLabel: 'Codes not arriving', count: 3 },
    { source: 'lockout_reset', reasonLabel: 'Worker confused by the steps', count: 0 },
    { source: 'lockout_reset', reasonLabel: 'Typo in their details', count: 1 },
    { source: 'lockout_reset', reasonLabel: 'Confirmed identity another way', count: 0 },
    { source: 'lockout_reset', reasonLabel: 'Other', count: 2 },
    { source: 'operator_reset', reasonLabel: 'Operator reset', count: 5 },
  ]);
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_reset_reasons($1)', params: [30] }]);
  capturePool([{ source: 'lockout_reset', reason_code: 'made_up', resets: '1' }]);
  await assert.rejects(analytics.getResetReasons(30), /Unexpected reset reason: made_up/);
  capturePool([{ source: 'sms_reset', reason_code: null, resets: '1' }]);
  await assert.rejects(analytics.getResetReasons(30), /Unexpected reset source: sms_reset/);

  // #6 open cases by age: the contract's labels, in order.
  sent = capturePool([
    { bucket: 'under_1h', waiting_on_us: '2', waiting_on_worker: '0' },
    { bucket: '1_4h', waiting_on_us: '1', waiting_on_worker: '1' },
    { bucket: '4_24h', waiting_on_us: '0', waiting_on_worker: '3' },
    { bucket: '1_3d', waiting_on_us: '4', waiting_on_worker: '0' },
    { bucket: 'over_3d', waiting_on_us: '0', waiting_on_worker: '6' },
  ]);
  assert.deepEqual(await analytics.getCaseAging(), [
    { label: '<1h', waitingOnUs: 2, waitingOnWorker: 0 },
    { label: '1–4h', waitingOnUs: 1, waitingOnWorker: 1 },
    { label: '4–24h', waitingOnUs: 0, waitingOnWorker: 3 },
    { label: '1–3d', waitingOnUs: 4, waitingOnWorker: 0 },
    { label: '>3d', waitingOnUs: 0, waitingOnWorker: 6 },
  ]);
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_case_aging()', params: undefined }]);
  capturePool([{ bucket: 'yesterday', waiting_on_us: '1', waiting_on_worker: '0' }]);
  await assert.rejects(analytics.getCaseAging(), /Unexpected case age bucket: yesterday/);

  // #6 resolutions: NUMERIC medians as strings, NULL when nothing was resolved.
  sent = capturePool([
    { week_start: d('2026-10-05T00:00:00.000Z'), partial: false, resolved: '3', median_hours: '20.0', p75_hours: '25.5' },
    { week_start: d('2026-10-12T00:00:00.000Z'), partial: true, resolved: '0', median_hours: null, p75_hours: null },
  ]);
  assert.deepEqual(await analytics.getCaseResolution(2), [
    { weekStart: '2026-10-05T00:00:00.000Z', partial: false, resolved: 3, medianHours: 20, p75Hours: 25.5 },
    { weekStart: '2026-10-12T00:00:00.000Z', partial: true, resolved: 0, medianHours: null, p75Hours: null },
  ]);
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_case_resolution($1)', params: [2] }]);

  // #14 onboarding steps: funnel.ts labels; of started and of the previous
  // main-line step (a branch step is against its fork; the step after a
  // branch skips it); the first step has no previous.
  const stepRow = (step_key, step_order, branch, reached, started = '10') => ({ step_key, step_order, branch, reached, started });
  sent = capturePool([
    stepRow('start.choose_language', 1, false, '10'),
    stepRow('identity.verify_otp', 2, false, '8'),
    stepRow('legal.review', 3, false, '6'),
    stepRow('profile.voice_choice', 4, false, '6'),
    stepRow('profile.voice_processing', 5, true, '2'),
    stepRow('profile.name', 6, false, '3'),
  ]);
  const steps = await analytics.getOnboardingSteps(8, 'whatsapp');
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_onboarding_steps($1, $2)', params: [8, 'whatsapp'] }]);
  assert.equal(steps.started, 10);
  assert.deepEqual(steps.steps.map((step) => [step.stepKey, step.label, step.order, step.branch, step.reached, step.ofStarted, step.ofPrevious]), [
    ['start.choose_language', 'Language', 1, false, 10, 100, null],
    ['identity.verify_otp', 'Phone code', 2, false, 8, 80, 80],
    ['legal.review', 'Terms', 3, false, 6, 60, 75],
    ['profile.voice_choice', 'Voice note', 4, false, 6, 60, 100],
    ['profile.voice_processing', 'Voice note processing', 5, true, 2, 20, (2 / 6) * 100],
    ['profile.name', 'Name', 6, false, 3, 30, 50],
  ]);
  capturePool([stepRow('legal.review', 3, false, '0', '0'), stepRow('profile.voice_choice', 4, false, '0', '0')]);
  const emptySteps = await analytics.getOnboardingSteps(8, 'web');
  assert.equal(emptySteps.started, 0);
  assert.deepEqual(emptySteps.steps.map((step) => [step.stepKey, step.ofStarted, step.ofPrevious]),
    [['legal.review', null, null], ['profile.voice_choice', null, null]], 'nothing started: no shares');
  capturePool([]);
  assert.deepEqual(await analytics.getOnboardingSteps(8, 'all'), { started: 0, steps: [] });

  // #15 identity funnel: exactly one row; a missing row is an error.
  sent = capturePool([{
    challenges: '20', reached_code: '15', verified: '11', locked_once: '2', expired_unused: '1',
    attempts_zero: '9', attempts_one: '3', attempts_two: '2', attempts_three_plus: '1',
    median_minutes_to_verify: '4.5', p75_minutes_to_verify: '9.0', timings_since: d('2026-10-02T09:30:00.000Z'),
  }]);
  assert.deepEqual(await analytics.getIdentityFunnel(8), {
    challenges: 20, reachedCode: 15, verified: 11, lockedOnce: 2, expiredUnused: 1,
    attempts: { zero: 9, one: 3, two: 2, threePlus: 1 },
    medianMinutesToVerify: 4.5, p75MinutesToVerify: 9, timingsSince: '2026-10-02T09:30:00.000Z',
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_identity_funnel($1)', params: [8] }]);
  capturePool([{
    challenges: '0', reached_code: '0', verified: '0', locked_once: '0', expired_unused: '0',
    attempts_zero: '0', attempts_one: '0', attempts_two: '0', attempts_three_plus: '0',
    median_minutes_to_verify: null, p75_minutes_to_verify: null, timings_since: null,
  }]);
  const noTimings = await analytics.getIdentityFunnel(8);
  assert.deepEqual([noTimings.medianMinutesToVerify, noTimings.p75MinutesToVerify, noTimings.timingsSince], [null, null, null]);
  capturePool([]);
  await assert.rejects(analytics.getIdentityFunnel(8), /admin_analytics_identity_funnel\(\) returned no row/);

  // #19 ranking freshness: the contract's bucket labels; older than 24 h is
  // the last two buckets; the fallback share is of the ranked jobs.
  sent = capturePool([{
    under_1h: '3', from_1h_to_6h: '2', from_6h_to_24h: '1', from_1d_to_3d: '4', over_3d: '2',
    ranked_jobs: '12', fallback_jobs: '3', jobs_with_applications_no_ranking: '5',
  }]);
  assert.deepEqual(await analytics.getRankingFreshness(), {
    buckets: [
      { label: '<1h', jobs: 3 }, { label: '1–6h', jobs: 2 }, { label: '6–24h', jobs: 1 },
      { label: '1–3d', jobs: 4 }, { label: '>3d', jobs: 2 },
    ],
    jobsOlderThan24h: 6, fallbackShare: 25, fallbackJobs: 3, rankedJobs: 12, jobsWithApplicationsButNoRanking: 5,
  });
  assert.deepEqual(sent, [{ sql: 'SELECT * FROM admin_analytics_ranking_freshness()', params: undefined }]);
  capturePool([{
    under_1h: '0', from_1h_to_6h: '0', from_6h_to_24h: '0', from_1d_to_3d: '0', over_3d: '0',
    ranked_jobs: '0', fallback_jobs: '0', jobs_with_applications_no_ranking: '2',
  }]);
  assert.equal((await analytics.getRankingFreshness()).fallbackShare, null, 'nothing ranked: no share');
  capturePool([]);
  await assert.rejects(analytics.getRankingFreshness(), /admin_analytics_ranking_freshness\(\) returned no row/);
}

// ---- K3.4 Home metrics (getHomeMetrics) ----
// Two statements, one after the other: the scalars (totals, this week's new
// paying employers, the 30-day hires and stale jobs) and the last 8 weeks of
// signups, drawn as a running total that ends at today's total.
{
  const check = (globalThis.__adminCheck ??= {});
  const homeNow = new Date('2026-10-14T15:00:00.000Z'); // a Wednesday; this week starts Oct 12
  const statements = [];
  let open = 0;
  let maxOpen = 0;
  const homePool = (scalars, signups) => ({
    query: async (sql, params) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open -= 1;
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: text, params });
      if (/admin_analytics_signups/.test(text)) return { rows: signups };
      return { rows: scalars };
    },
  });
  const scalars = [{
    total_workers: '50', total_employers: '10', paying_employers: '4', jobs_active: '7',
    paying_new_this_week: '1', hires_last_30d: '9', jobs_with_hire_last_30d: '6', stale_jobs_14d: '2',
  }];
  check.pool = homePool(scalars, [
    { bucket_start: new Date('2026-09-28T00:00:00.000Z'), worker_signups: '2', employer_signups: '1', worker_signups_verified: '1' },
    { bucket_start: new Date('2026-10-12T00:00:00.000Z'), worker_signups: '3', employer_signups: '0', worker_signups_verified: '2' },
  ]);
  const home = await analytics.getHomeMetrics(homeNow);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /FROM admin_analytics_totals\(\) t CROSS JOIN admin_analytics_paying_weekly\(1\) p CROSS JOIN admin_analytics_home_metrics\(\) h/);
  assert.equal(statements[0].params, undefined);
  assert.deepEqual(statements[1], {
    sql: 'SELECT * FROM admin_analytics_signups($1, $2)',
    params: [new Date('2026-08-24T00:00:00.000Z'), 'week'],
  });
  assert.equal(maxOpen, 1, 'one statement at a time: the loader holds at most one pool connection');
  const weekStarts = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']
    .map((day) => `${day}T00:00:00.000Z`);
  assert.deepEqual(home, {
    signupsTotal: 60, signupsThisWeek: 3,
    payingEmployers: 4, payingThisWeek: 1,
    hiresLast30d: 9, jobsWithHireLast30d: 6,
    openJobs: 7, staleJobs14d: 2,
    // 60 today; 6 in the window, so 54 before it.
    signupsWeekly: weekStarts.map((weekStart, i) => ({
      weekStart, partial: i === 7, cumulative: [54, 54, 54, 54, 54, 57, 57, 60][i],
    })),
  });

  // No scalar row is an error, never zeros.
  check.pool = homePool([], []);
  await assert.rejects(analytics.getHomeMetrics(homeNow), /Home metrics returned no row/);
}

console.log('check-analytics-helpers: all assertions passed');
