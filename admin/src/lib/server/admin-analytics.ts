import type {
  AnalyticsBucket,
  AnalyticsRange,
  AnalyticsTotals,
  BillingInboxNow,
  BillingInboxWeekly,
  EmployerWeekly,
  FunnelDoor,
  FunnelWeeks,
  JobsActivityBucket,
  MessageBacklogLane,
  MessageFailuresWeekly,
  MessageLane,
  MessageTrafficBucket,
  OnboardingCohort,
  OnboardingStalled,
  PayingEmployer,
  SignupBucket,
  SignupsView,
  SlowestEmployer,
  StaleJob,
  TrustExtractionWeekly,
  VoiceExtractionWeekly,
} from '../types';
import { isMessageLane } from '../ops-health';
import { getAdminDbPool } from './db';

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = '30d';

export const DEFAULT_SIGNUPS_VIEW: SignupsView = 'total';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseAnalyticsRange(value: unknown): AnalyticsRange {
  return value === '7d' || value === '30d' || value === '90d' ? value : DEFAULT_ANALYTICS_RANGE;
}

export function parseSignupsView(value: unknown): SignupsView {
  return value === 'new' ? 'new' : DEFAULT_SIGNUPS_VIEW;
}

function utcStartOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ISO weeks start Monday, matching Postgres date_trunc('week', ...).
function utcStartOfIsoWeek(date: Date): Date {
  const day = utcStartOfDay(date);
  const isoDow = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - isoDow * DAY_MS);
}

export type ResolvedRange = { from: Date; bucket: AnalyticsBucket };

export function resolveRange(range: AnalyticsRange, now: Date = new Date()): ResolvedRange {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const bucket: AnalyticsBucket = range === '90d' ? 'week' : 'day';
  const earliest = new Date(now.getTime() - (days - 1) * DAY_MS);
  const from = bucket === 'day' ? utcStartOfDay(earliest) : utcStartOfIsoWeek(earliest);
  return { from, bucket };
}

export function bucketStarts(from: Date, bucket: AnalyticsBucket, now: Date = new Date()): string[] {
  const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  const last = bucket === 'day' ? utcStartOfDay(now) : utcStartOfIsoWeek(now);
  const starts: string[] = [];

  for (let t = from.getTime(); t <= last.getTime(); t += step) {
    starts.push(new Date(t).toISOString());
  }

  return starts;
}

// GROUP BY date_trunc skips empty buckets; the UI needs a contiguous axis.
export function fillBuckets<T extends { bucketStart: string }>(
  rows: T[],
  starts: string[],
  zero: (bucketStart: string) => T,
): T[] {
  const byStart = new Map(rows.map((row) => [row.bucketStart, row]));
  return starts.map((start) => byStart.get(start) ?? zero(start));
}

type PgTimestamp = Date | string;

function asIso(value: PgTimestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asCount(value: string | number): number {
  return typeof value === 'number' ? value : parseInt(value, 10);
}

export type TotalsRow = {
  total_workers: string | number;
  total_employers: string | number;
  paying_employers: string | number;
  jobs_active: string | number;
  jobs_paused: string | number;
  jobs_filled: string | number;
  jobs_closed: string | number;
  hires_total: string | number;
  jobs_with_hire: string | number;
  total_verified_workers?: string | number;
};

export function mapTotalsRow(row: TotalsRow): AnalyticsTotals {
  return {
    totalWorkers: asCount(row.total_workers),
    totalEmployers: asCount(row.total_employers),
    payingEmployers: asCount(row.paying_employers),
    jobsActive: asCount(row.jobs_active),
    jobsPaused: asCount(row.jobs_paused),
    jobsFilled: asCount(row.jobs_filled),
    jobsClosed: asCount(row.jobs_closed),
    hiresTotal: asCount(row.hires_total),
    jobsWithHire: asCount(row.jobs_with_hire),
    totalVerifiedWorkers: asCount(row.total_verified_workers ?? 0),
  };
}

export type SignupRow = {
  bucket_start: PgTimestamp;
  worker_signups: string | number;
  employer_signups: string | number;
  worker_signups_verified?: string | number;
};

export function mapSignupRow(row: SignupRow): SignupBucket {
  return {
    bucketStart: asIso(row.bucket_start),
    workerSignups: asCount(row.worker_signups),
    employerSignups: asCount(row.employer_signups),
    workerSignupsVerified: asCount(row.worker_signups_verified ?? 0),
  };
}

export type JobsActivityRow = {
  bucket_start: PgTimestamp;
  jobs_posted: string | number;
  applications_submitted: string | number;
};

export function mapJobsActivityRow(row: JobsActivityRow): JobsActivityBucket {
  return {
    bucketStart: asIso(row.bucket_start),
    jobsPosted: asCount(row.jobs_posted),
    applicationsSubmitted: asCount(row.applications_submitted),
  };
}

export type MessageTrafficRow = {
  bucket_start: PgTimestamp;
  job_messages_out: string | number;
  job_messages_in: string | number;
  job_messages_failed: string | number;
  wa_inbound: string | number;
  wa_outbound: string | number;
  wa_failed: string | number;
};

export function mapMessageTrafficRow(row: MessageTrafficRow): MessageTrafficBucket {
  return {
    bucketStart: asIso(row.bucket_start),
    jobMessagesOut: asCount(row.job_messages_out),
    jobMessagesIn: asCount(row.job_messages_in),
    jobMessagesFailed: asCount(row.job_messages_failed),
    waInbound: asCount(row.wa_inbound),
    waOutbound: asCount(row.wa_outbound),
    waFailed: asCount(row.wa_failed),
  };
}

export type PayingEmployerRow = {
  employer_id: string;
  display_name: string;
  plan_code: string;
  status: string;
  current_period_end: PgTimestamp | null;
  cancel_at_period_end: boolean;
};

export function mapPayingEmployerRow(row: PayingEmployerRow): PayingEmployer {
  return {
    employerId: row.employer_id,
    displayName: row.display_name,
    planCode: row.plan_code,
    status: row.status,
    ...(row.current_period_end ? { currentPeriodEnd: asIso(row.current_period_end) } : {}),
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export async function getAnalyticsTotals(): Promise<AnalyticsTotals> {
  const pool = await getAdminDbPool();
  const result = await pool.query<TotalsRow>('SELECT * FROM admin_analytics_totals()');
  return mapTotalsRow(result.rows[0]);
}

export async function getSignups(range: AnalyticsRange, now: Date = new Date()): Promise<SignupBucket[]> {
  const { from, bucket } = resolveRange(range, now);
  const pool = await getAdminDbPool();
  const result = await pool.query<SignupRow>(
    'SELECT * FROM admin_analytics_signups($1, $2)',
    [from, bucket],
  );
  return fillBuckets(
    result.rows.map(mapSignupRow),
    bucketStarts(from, bucket, now),
    (bucketStart) => ({ bucketStart, workerSignups: 0, employerSignups: 0, workerSignupsVerified: 0 }),
  );
}

export async function getJobsActivity(range: AnalyticsRange, now: Date = new Date()): Promise<JobsActivityBucket[]> {
  const { from, bucket } = resolveRange(range, now);
  const pool = await getAdminDbPool();
  const result = await pool.query<JobsActivityRow>(
    'SELECT * FROM admin_analytics_jobs_activity($1, $2)',
    [from, bucket],
  );
  return fillBuckets(
    result.rows.map(mapJobsActivityRow),
    bucketStarts(from, bucket, now),
    (bucketStart) => ({ bucketStart, jobsPosted: 0, applicationsSubmitted: 0 }),
  );
}

export async function getMessageTraffic(range: AnalyticsRange, now: Date = new Date()): Promise<MessageTrafficBucket[]> {
  const { from, bucket } = resolveRange(range, now);
  const pool = await getAdminDbPool();
  const result = await pool.query<MessageTrafficRow>(
    'SELECT * FROM admin_analytics_message_traffic($1, $2)',
    [from, bucket],
  );
  return fillBuckets(
    result.rows.map(mapMessageTrafficRow),
    bucketStarts(from, bucket, now),
    (bucketStart) => ({
      bucketStart,
      jobMessagesOut: 0,
      jobMessagesIn: 0,
      jobMessagesFailed: 0,
      waInbound: 0,
      waOutbound: 0,
      waFailed: 0,
    }),
  );
}

export async function getPayingEmployers(): Promise<PayingEmployer[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<PayingEmployerRow>('SELECT * FROM admin_analytics_paying_employers()');
  return result.rows.map(mapPayingEmployerRow);
}

// ---- 2a: worker onboarding funnel (migration 113) ----
export const DEFAULT_FUNNEL_WEEKS: FunnelWeeks = 8;
export const DEFAULT_FUNNEL_DOOR: FunnelDoor = 'all';
// Matches the cohorts function's abandoned threshold.
export const FUNNEL_STALLED_DAYS = 7;

export function parseFunnelWeeks(value: unknown): FunnelWeeks {
  return value === '4' ? 4 : value === '12' ? 12 : DEFAULT_FUNNEL_WEEKS;
}

export function parseFunnelDoor(value: unknown): FunnelDoor {
  return value === 'whatsapp' || value === 'web' ? value : DEFAULT_FUNNEL_DOOR;
}

export type OnboardingCohortRow = {
  cohort_week: PgTimestamp;
  door: string;
  started: string | number;
  code_requested: string | number;
  verified: string | number;
  accepted_terms: string | number;
  finished_profile: string | number;
  ready: string | number;
  declined: string | number;
  in_progress: string | number;
  abandoned: string | number;
};

export function mapOnboardingCohortRow(row: OnboardingCohortRow): OnboardingCohort {
  if (row.door !== 'whatsapp' && row.door !== 'web') {
    throw new Error(`Unexpected funnel door: ${row.door}`);
  }
  return {
    cohortWeek: asIso(row.cohort_week),
    door: row.door,
    started: asCount(row.started),
    codeRequested: asCount(row.code_requested),
    verified: asCount(row.verified),
    acceptedTerms: asCount(row.accepted_terms),
    finishedProfile: asCount(row.finished_profile),
    ready: asCount(row.ready),
    declined: asCount(row.declined),
    inProgress: asCount(row.in_progress),
    abandoned: asCount(row.abandoned),
  };
}

export type OnboardingStalledRow = {
  door: string;
  step_key: string;
  workers: string | number;
};

export function mapOnboardingStalledRow(row: OnboardingStalledRow): OnboardingStalled {
  const door = row.door === 'whatsapp' || row.door === 'web' ? row.door : 'other';
  return { door, stepKey: row.step_key, workers: asCount(row.workers) };
}

export async function getOnboardingCohorts(weeks: FunnelWeeks): Promise<OnboardingCohort[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<OnboardingCohortRow>(
    'SELECT * FROM admin_analytics_onboarding_cohorts($1)',
    [weeks],
  );
  return result.rows.map(mapOnboardingCohortRow);
}

export async function getOnboardingStalled(): Promise<OnboardingStalled[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<OnboardingStalledRow>(
    'SELECT * FROM admin_analytics_onboarding_stalled($1)',
    [FUNNEL_STALLED_DAYS],
  );
  return result.rows.map(mapOnboardingStalledRow);
}

// ---- 2b: employer health (migration 114) ----
// The weeks picker reuses 2a's parseFunnelWeeks / FunnelWeeks (4 | 8 | 12).
// Passed explicitly so the page copy ("14+ days", top 10) and the SQL agree.
export const STALE_JOB_DAYS = 14;
export const SLOWEST_EMPLOYERS_LIMIT = 10;

// NUMERIC arrives as a string ("5.2"); NULL (nothing to time) stays null.
function asNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

export type EmployerWeeklyRow = {
  week_start: PgTimestamp | null;
  applications: string | number;
  answered: string | number;
  answered_untimed: string | number;
  unanswered_7d: string | number;
  applications_due: string | number;
  first_response_p50_hours: string | number | null;
  first_response_p75_hours: string | number | null;
  worker_turns: string | number;
  turns_unanswered_7d: string | number;
  turns_due: string | number;
  reply_p50_hours: string | number | null;
  reply_p75_hours: string | number | null;
  hires: string | number;
  hires_approximate: string | number;
  time_to_hire_p50_days: string | number | null;
  time_to_hire_p75_days: string | number | null;
  active_jobs: string | number | null;
};

export function mapEmployerWeeklyRow(row: EmployerWeeklyRow): EmployerWeekly {
  return {
    weekStart: row.week_start === null ? null : asIso(row.week_start),
    applications: asCount(row.applications),
    answered: asCount(row.answered),
    answeredUntimed: asCount(row.answered_untimed),
    unanswered7d: asCount(row.unanswered_7d),
    applicationsDue: asCount(row.applications_due),
    firstResponseP50Hours: asNullableNumber(row.first_response_p50_hours),
    firstResponseP75Hours: asNullableNumber(row.first_response_p75_hours),
    workerTurns: asCount(row.worker_turns),
    turnsUnanswered7d: asCount(row.turns_unanswered_7d),
    turnsDue: asCount(row.turns_due),
    replyP50Hours: asNullableNumber(row.reply_p50_hours),
    replyP75Hours: asNullableNumber(row.reply_p75_hours),
    hires: asCount(row.hires),
    hiresApproximate: asCount(row.hires_approximate),
    timeToHireP50Days: asNullableNumber(row.time_to_hire_p50_days),
    timeToHireP75Days: asNullableNumber(row.time_to_hire_p75_days),
    activeJobs: row.active_jobs === null ? null : asCount(row.active_jobs),
  };
}

export type SlowestEmployerRow = {
  employer_id: string;
  display_name: string;
  applications: string | number;
  unanswered_7d: string | number;
  first_response_p50_hours: string | number | null;
  active_jobs: string | number;
};

export function mapSlowestEmployerRow(row: SlowestEmployerRow): SlowestEmployer {
  return {
    employerId: row.employer_id,
    displayName: row.display_name,
    applications: asCount(row.applications),
    unanswered7d: asCount(row.unanswered_7d),
    firstResponseP50Hours: asNullableNumber(row.first_response_p50_hours),
    activeJobs: asCount(row.active_jobs),
  };
}

export type StaleJobRow = {
  job_id: string;
  title: string;
  employer_id: string;
  display_name: string;
  posted_at: PgTimestamp;
  last_employer_action_at: PgTimestamp;
  days_idle: string | number;
  waiting_applicants: string | number;
  last_application_at: PgTimestamp | null;
};

export function mapStaleJobRow(row: StaleJobRow): StaleJob {
  return {
    jobId: row.job_id,
    title: row.title,
    employerId: row.employer_id,
    displayName: row.display_name,
    postedAt: asIso(row.posted_at),
    lastEmployerActionAt: asIso(row.last_employer_action_at),
    daysIdle: asCount(row.days_idle),
    waitingApplicants: asCount(row.waiting_applicants),
    lastApplicationAt: row.last_application_at === null ? null : asIso(row.last_application_at),
  };
}

// Every week in the window (zero-filled by SQL) plus the whole-window row
// (weekStart null); employer-health.ts splits them.
export async function getEmployerWeekly(weeks: FunnelWeeks): Promise<EmployerWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<EmployerWeeklyRow>(
    'SELECT * FROM admin_analytics_employer_weekly($1)',
    [weeks],
  );
  return result.rows.map(mapEmployerWeeklyRow);
}

export async function getSlowestEmployers(weeks: FunnelWeeks): Promise<SlowestEmployer[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<SlowestEmployerRow>(
    'SELECT * FROM admin_analytics_slowest_employers($1, $2)',
    [weeks, SLOWEST_EMPLOYERS_LIMIT],
  );
  return result.rows.map(mapSlowestEmployerRow);
}

// Every stale active job, most idle first; the page shows the first 25.
export async function getStaleJobs(): Promise<StaleJob[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<StaleJobRow>(
    'SELECT * FROM admin_analytics_stale_jobs($1)',
    [STALE_JOB_DAYS],
  );
  return result.rows.map(mapStaleJobRow);
}

// ---- 2c: ops health (migration 115) ----
// The weeks picker reuses 2a's parseFunnelWeeks / FunnelWeeks (4 | 8 | 12).

function asNullableIso(value: PgTimestamp | null): string | null {
  return value === null ? null : asIso(value);
}

// Lane ids are a contract with migration 115: an unknown id is an error, not
// a row the page would silently mislabel.
function asLane(value: string): MessageLane {
  if (!isMessageLane(value)) {
    throw new Error(`Unexpected message lane: ${value}`);
  }
  return value;
}

export type MessageBacklogRow = {
  lane: string;
  open_under_1h: string | number;
  open_1_24h: string | number;
  open_24_48h: string | number;
  stuck: string | number;
  oldest_stuck_at: PgTimestamp | null;
};

export function mapMessageBacklogRow(row: MessageBacklogRow): MessageBacklogLane {
  return {
    lane: asLane(row.lane),
    openUnder1h: asCount(row.open_under_1h),
    open1To24h: asCount(row.open_1_24h),
    open24To48h: asCount(row.open_24_48h),
    stuck: asCount(row.stuck),
    oldestStuckAt: asNullableIso(row.oldest_stuck_at),
  };
}

export type MessageFailuresRow = {
  week_start: PgTimestamp | null;
  lane: string | null;
  created: string | number;
  gave_up: string | number;
  delivery_failed: string | number;
};

export function mapMessageFailuresRow(row: MessageFailuresRow): MessageFailuresWeekly {
  return {
    weekStart: asNullableIso(row.week_start),
    lane: row.lane === null ? null : asLane(row.lane),
    created: asCount(row.created),
    gaveUp: asCount(row.gave_up),
    deliveryFailed: asCount(row.delivery_failed),
  };
}

export type VoiceExtractionRow = {
  week_start: PgTimestamp | null;
  model: string | null;
  processed: string | number;
  failed: string | number;
  failed_transcribe: string | number;
  failed_empty_transcript: string | number;
  failed_audio_read: string | number;
  failed_model_call: string | number;
  failed_bad_json: string | number;
  failed_bad_shape: string | number;
  failed_pipeline_error: string | number;
  failed_unrecorded: string | number;
  usable: string | number;
  full_name_found: string | number;
  city_found: string | number;
  main_trade_found: string | number;
  main_trade_other_due: string | number;
  main_trade_other_found: string | number;
  years_experience_found: string | number;
  has_transportation_found: string | number;
  availability_found: string | number;
};

export function mapVoiceExtractionRow(row: VoiceExtractionRow): VoiceExtractionWeekly {
  return {
    weekStart: asNullableIso(row.week_start),
    model: row.model,
    processed: asCount(row.processed),
    failed: asCount(row.failed),
    failedTranscribe: asCount(row.failed_transcribe),
    failedEmptyTranscript: asCount(row.failed_empty_transcript),
    failedAudioRead: asCount(row.failed_audio_read),
    failedModelCall: asCount(row.failed_model_call),
    failedBadJson: asCount(row.failed_bad_json),
    failedBadShape: asCount(row.failed_bad_shape),
    failedPipelineError: asCount(row.failed_pipeline_error),
    failedUnrecorded: asCount(row.failed_unrecorded),
    usable: asCount(row.usable),
    fullNameFound: asCount(row.full_name_found),
    cityFound: asCount(row.city_found),
    mainTradeFound: asCount(row.main_trade_found),
    mainTradeOtherDue: asCount(row.main_trade_other_due),
    mainTradeOtherFound: asCount(row.main_trade_other_found),
    yearsExperienceFound: asCount(row.years_experience_found),
    hasTransportationFound: asCount(row.has_transportation_found),
    availabilityFound: asCount(row.availability_found),
  };
}

export type TrustExtractionRow = {
  week_start: PgTimestamp | null;
  extractor_version: string | null;
  extractions: string | number;
  failed: string | number;
  not_enough_detail: string | number;
  avg_sections: string | number | null;
};

export function mapTrustExtractionRow(row: TrustExtractionRow): TrustExtractionWeekly {
  return {
    weekStart: asNullableIso(row.week_start),
    extractorVersion: row.extractor_version,
    extractions: asCount(row.extractions),
    failed: asCount(row.failed),
    notEnoughDetail: asCount(row.not_enough_detail),
    avgSections: asNullableNumber(row.avg_sections),
  };
}

export type BillingInboxRow = {
  week_start: PgTimestamp | null;
  event_type: string | null;
  received: string | number;
  processed: string | number;
  skipped: string | number;
  failed: string | number;
  retried: string | number;
  payment_failed_invoices: string | number;
};

export function mapBillingInboxRow(row: BillingInboxRow): BillingInboxWeekly {
  return {
    weekStart: asNullableIso(row.week_start),
    eventType: row.event_type,
    received: asCount(row.received),
    processed: asCount(row.processed),
    skipped: asCount(row.skipped),
    failed: asCount(row.failed),
    retried: asCount(row.retried),
    paymentFailedInvoices: asCount(row.payment_failed_invoices),
  };
}

export type BillingInboxNowRow = {
  stuck_received: string | number;
  failed_now: string | number;
  unresolved_older: string | number;
  oldest_stuck_at: PgTimestamp | null;
};

export function mapBillingInboxNowRow(row: BillingInboxNowRow): BillingInboxNow {
  return {
    stuckReceived: asCount(row.stuck_received),
    failedNow: asCount(row.failed_now),
    unresolvedOlder: asCount(row.unresolved_older),
    oldestStuckAt: asNullableIso(row.oldest_stuck_at),
  };
}

// One row per active lane (zeros included), plus job alerts while they have
// open rows. Open rows are under 48 h old.
export async function getMessageBacklog(): Promise<MessageBacklogLane[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<MessageBacklogRow>('SELECT * FROM admin_analytics_message_backlog()');
  return result.rows.map(mapMessageBacklogRow);
}

// Every (week, lane) pair plus the whole-window rows; ops-health.ts splits them.
export async function getMessageFailures(weeks: FunnelWeeks): Promise<MessageFailuresWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<MessageFailuresRow>(
    'SELECT * FROM admin_analytics_message_failures($1)',
    [weeks],
  );
  return result.rows.map(mapMessageFailuresRow);
}

export async function getVoiceExtraction(weeks: FunnelWeeks): Promise<VoiceExtractionWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<VoiceExtractionRow>(
    'SELECT * FROM admin_analytics_voice_extraction($1)',
    [weeks],
  );
  return result.rows.map(mapVoiceExtractionRow);
}

export async function getTrustExtraction(weeks: FunnelWeeks): Promise<TrustExtractionWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<TrustExtractionRow>(
    'SELECT * FROM admin_analytics_trust_extraction($1)',
    [weeks],
  );
  return result.rows.map(mapTrustExtractionRow);
}

export async function getBillingInbox(weeks: FunnelWeeks): Promise<BillingInboxWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<BillingInboxRow>(
    'SELECT * FROM admin_analytics_billing_inbox($1)',
    [weeks],
  );
  return result.rows.map(mapBillingInboxRow);
}

// Exactly one row; a missing row is an error, never "nothing stuck".
export async function getBillingInboxNow(): Promise<BillingInboxNow> {
  const pool = await getAdminDbPool();
  const result = await pool.query<BillingInboxNowRow>('SELECT * FROM admin_analytics_billing_inbox_now()');
  const row = result.rows[0];
  if (!row) {
    throw new Error('admin_analytics_billing_inbox_now() returned no row');
  }
  return mapBillingInboxNowRow(row);
}
