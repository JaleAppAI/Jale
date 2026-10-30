import type {
  AnalyticsBucket,
  AnalyticsRange,
  AnalyticsTotals,
  BillingInboxNow,
  BillingInboxWeekly,
  CompanyMember,
  CompanySummary,
  DigestAdoption,
  DigestSendsWeekly,
  EmployerWeekly,
  FunnelDoor,
  FunnelWeeks,
  JobsActivityBucket,
  MessageBacklogLane,
  MessageFailuresWeekly,
  MessageLane,
  MessageTrafficBucket,
  OnboardingCohort,
  OnboardingRestart,
  OnboardingStalled,
  OperatorReset,
  PayingEmployer,
  SignupBucket,
  SignupsView,
  SlowestEmployer,
  StaleJob,
  TrustExtractionWeekly,
  VoiceExtractionWeekly,
} from '../types';
import { cumulativeSeries } from '../analytics-format';
import { STALE_JOBS_SHOWN, firstWithRest } from '../employer-health';
import { stepLabel } from '../funnel';
import { LOCKOUT_RESET_REASONS } from '../lockout-reasons';
import { isMessageLane } from '../ops-health';
import { isUuid } from './audit/codes';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AttemptOutcome,
  type AuditQueryClient,
} from './audit/record';
import { readDlqDepth, readSesBounces24h, type DlqQueue } from './aws-health';
import { getAdminDbPool } from './db';
import type { AdminSession } from './session-claims';

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

export function resolveRange(range: AnalyticsRange | FunnelWeeks, now: Date = new Date()): ResolvedRange {
  // K3.0: a number of weeks is this ISO week and the weeks - 1 before it, weekly.
  if (typeof range === 'number') {
    return { from: new Date(utcStartOfIsoWeek(now).getTime() - (range - 1) * 7 * DAY_MS), bucket: 'week' };
  }
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
  organization_id: string;
  members_active: string | number;
  seats_used: string | number;
  seats_pending: string | number;
  seats_suspended: string | number;
  seat_limit: number | null;
};

export function mapPayingEmployerRow(row: PayingEmployerRow): PayingEmployer {
  return {
    employerId: row.employer_id,
    displayName: row.display_name,
    planCode: row.plan_code,
    status: row.status,
    ...(row.current_period_end ? { currentPeriodEnd: asIso(row.current_period_end) } : {}),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    organizationId: row.organization_id,
    membersActive: asCount(row.members_active),
    seatsUsed: asCount(row.seats_used),
    seatsPending: asCount(row.seats_pending),
    seatsSuspended: asCount(row.seats_suspended),
    seatLimit: row.seat_limit,
  };
}

export async function getAnalyticsTotals(): Promise<AnalyticsTotals> {
  const pool = await getAdminDbPool();
  const result = await pool.query<TotalsRow>('SELECT * FROM admin_analytics_totals()');
  return mapTotalsRow(result.rows[0]);
}

export async function getSignups(range: AnalyticsRange | FunnelWeeks, now: Date = new Date()): Promise<SignupBucket[]> {
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

export async function getJobsActivity(range: AnalyticsRange | FunnelWeeks, now: Date = new Date()): Promise<JobsActivityBucket[]> {
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

export async function getMessageTraffic(range: AnalyticsRange | FunnelWeeks, now: Date = new Date()): Promise<MessageTrafficBucket[]> {
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

export async function getPayingEmployers(client: AuditQueryClient): Promise<PayingEmployer[]> {
  const result = await client.query<PayingEmployerRow>('SELECT * FROM admin_analytics_paying_employers()');
  return result.rows.map(mapPayingEmployerRow);
}

/**
 * Of the analytics page, only the paying-employers list names anyone, so
 * it alone is read in a recorded transaction. The aggregates are not
 * recorded. A read that fails records a failed attempt once its client is
 * released.
 */
export async function loadPayingEmployers(session: AdminSession): Promise<PayingEmployer[]> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const rows = await getPayingEmployers(client);
      await recordAdminAccess(session, {
        surface: 'admin.analytics_paying_employers',
        categories: ['analytics', 'billing'],
        subjectUserIds: rows.map((row) => row.employerId),
        resultCount: rows.length,
      }, client);
      return rows;
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.analytics_paying_employers',
      categories: ['analytics', 'billing'],
      outcome: 'failed',
    });
    throw error;
  }
}

// ---- Phase 5: companies (migration 139) ----
// The Companies panel shows the top 100 by seats, then members, then jobs.
export const COMPANIES_LIMIT = 100;

export type CompanySummaryRow = {
  organization_id: string;
  owner_id: string;
  display_name: string;
  created_at: PgTimestamp;
  // NULL when the company has no eligible subscription and the catalog has
  // no active employer_free row (139's LEFT JOIN keeps the company listed).
  plan_code: string | null;
  plan_status: string | null;
  members_active: string | number;
  seats_used: string | number;
  seats_pending: string | number;
  seats_suspended: string | number;
  seat_limit: number | null;
  active_jobs: string | number;
};

export function mapCompanySummaryRow(row: CompanySummaryRow): CompanySummary {
  return {
    organizationId: row.organization_id,
    ownerId: row.owner_id,
    displayName: row.display_name,
    createdAt: asIso(row.created_at),
    planCode: row.plan_code,
    planStatus: row.plan_status,
    membersActive: asCount(row.members_active),
    seatsUsed: asCount(row.seats_used),
    seatsPending: asCount(row.seats_pending),
    seatsSuspended: asCount(row.seats_suspended),
    seatLimit: row.seat_limit,
    activeJobs: asCount(row.active_jobs),
  };
}

export type CompanyMemberRow = {
  user_id: string;
  display_name: string | null;
  role: string;
  status: string;
  billing_suspended: boolean;
  joined_at: PgTimestamp;
  status_changed_at: PgTimestamp | null;
  active_jobs: string | number;
};

// Role and status are a contract with migration 139: an unknown value is an
// error, not a member the page would silently mislabel.
export function mapCompanyMemberRow(row: CompanyMemberRow): CompanyMember {
  if (row.role !== 'owner' && row.role !== 'foreman') {
    throw new Error(`Unexpected member role: ${row.role}`);
  }
  if (row.status !== 'active' && row.status !== 'suspended' && row.status !== 'removed') {
    throw new Error(`Unexpected member status: ${row.status}`);
  }
  return {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    billingSuspended: row.billing_suspended,
    joinedAt: asIso(row.joined_at),
    statusChangedAt: asNullableIso(row.status_changed_at),
    activeJobs: asCount(row.active_jobs),
  };
}

export async function getCompanies(client: AuditQueryClient): Promise<CompanySummary[]> {
  const result = await client.query<CompanySummaryRow>(
    'SELECT * FROM admin_analytics_companies($1::int, NULL)',
    [COMPANIES_LIMIT],
  );
  return result.rows.map(mapCompanySummaryRow);
}

export async function getCompany(client: AuditQueryClient, organizationId: string): Promise<CompanySummary | null> {
  const result = await client.query<CompanySummaryRow>(
    'SELECT * FROM admin_analytics_companies(1, $1::uuid)',
    [organizationId],
  );
  return result.rows[0] ? mapCompanySummaryRow(result.rows[0]) : null;
}

export async function getCompanyMembers(client: AuditQueryClient, organizationId: string): Promise<CompanyMember[]> {
  const result = await client.query<CompanyMemberRow>(
    'SELECT * FROM admin_analytics_company_members($1::uuid)',
    [organizationId],
  );
  return result.rows.map(mapCompanyMemberRow);
}

/**
 * The Companies panel names owners, so it is read in a recorded transaction
 * like the paying-employers list. A read that fails records a failed attempt
 * once its client is released.
 */
export async function loadCompanies(session: AdminSession): Promise<CompanySummary[]> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const rows = await getCompanies(client);
      await recordAdminAccess(session, {
        surface: 'admin.analytics_companies',
        categories: ['analytics', 'billing'],
        subjectUserIds: rows.map((row) => row.ownerId),
        resultCount: rows.length,
      }, client);
      return rows;
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.analytics_companies',
      categories: ['analytics', 'billing'],
      outcome: 'failed',
    });
    throw error;
  }
}

/**
 * One company and every member it has had, removed ones included; all of
 * their ids are recorded. A malformed or unknown id records a not_found
 * attempt (the unknown one once the transaction has ended); a read that
 * fails records a failed attempt once its client is released.
 */
export async function loadCompany(
  session: AdminSession,
  organizationId: string,
): Promise<{ company: CompanySummary | null; members: CompanyMember[] }> {
  const attempt = (outcome: AttemptOutcome) => recordAdminAttempt(session, {
    surface: 'admin.analytics_company_members',
    categories: ['analytics', 'billing', 'profile'],
    outcome,
  });

  if (!isUuid(organizationId)) {
    await attempt('not_found');
    return { company: null, members: [] };
  }

  let loaded: { company: CompanySummary | null; members: CompanyMember[] };
  try {
    loaded = await withAdminReadTransaction(session, async (client) => {
      const company = await getCompany(client, organizationId);
      if (!company) {
        return { company: null, members: [] };
      }
      const members = await getCompanyMembers(client, organizationId);
      await recordAdminAccess(session, {
        surface: 'admin.analytics_company_members',
        categories: ['analytics', 'billing', 'profile'],
        subjectUserIds: members.map((member) => member.userId),
        resultCount: members.length,
      }, client);
      return { company, members };
    });
  } catch (error) {
    await attempt('failed');
    throw error;
  }

  if (!loaded.company) {
    await attempt('not_found');
  }
  return loaded;
}

// ---- 2a: worker onboarding funnel (migration 113) ----
export const DEFAULT_FUNNEL_WEEKS: FunnelWeeks = 8;
export const DEFAULT_FUNNEL_DOOR: FunnelDoor = 'all';
// Matches the cohorts function's abandoned threshold.
export const FUNNEL_STALLED_DAYS = 7;

export function parseFunnelWeeks(value: unknown): FunnelWeeks {
  return value === '13' ? 13 : value === '26' ? 26 : DEFAULT_FUNNEL_WEEKS;
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
// The weeks picker reuses 2a's parseFunnelWeeks / FunnelWeeks (8 | 13 | 26).
// Passed explicitly so the page copy ("14+ days", top 10) and the SQL agree.
export const STALE_JOB_DAYS = 14;
export const SLOWEST_EMPLOYERS_LIMIT = 10;

// Contract K3.2 (sprint 28): the stale-jobs picker offers 7 / 14 / 30 days
// (`?stale=`), default 14.
export type StaleDays = 7 | 14 | 30;

export function parseStaleDays(v: string | string[] | undefined): StaleDays {
  return v === '7' ? 7 : v === '30' ? 30 : STALE_JOB_DAYS;
}

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
  organization_id: string | null;
};

export function mapSlowestEmployerRow(row: SlowestEmployerRow): SlowestEmployer {
  return {
    employerId: row.employer_id,
    displayName: row.display_name,
    applications: asCount(row.applications),
    unanswered7d: asCount(row.unanswered_7d),
    firstResponseP50Hours: asNullableNumber(row.first_response_p50_hours),
    activeJobs: asCount(row.active_jobs),
    organizationId: row.organization_id,
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

export async function getSlowestEmployers(client: AuditQueryClient, weeks: FunnelWeeks): Promise<SlowestEmployer[]> {
  const result = await client.query<SlowestEmployerRow>(
    'SELECT * FROM admin_analytics_slowest_employers($1, $2)',
    [weeks, SLOWEST_EMPLOYERS_LIMIT],
  );
  return result.rows.map(mapSlowestEmployerRow);
}

// Every stale active job, most idle first; the page shows the first 25.
export async function getStaleJobs(client: AuditQueryClient, days: StaleDays): Promise<StaleJob[]> {
  const result = await client.query<StaleJobRow>(
    'SELECT * FROM admin_analytics_stale_jobs($1)',
    [days],
  );
  return result.rows.map(mapStaleJobRow);
}

/**
 * Of the Employers page, only the two lists name anyone (employers), so each
 * is read in a recorded transaction, as the paying-employers list is. The
 * weekly figures, the tiles and the digest counts are aggregates and are not
 * recorded. A read that fails records a failed attempt once its client is
 * released.
 */
export async function loadSlowestEmployers(session: AdminSession, weeks: FunnelWeeks): Promise<SlowestEmployer[]> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const rows = await getSlowestEmployers(client, weeks);
      await recordAdminAccess(session, {
        surface: 'admin.analytics_slowest_employers',
        categories: ['analytics'],
        subjectUserIds: rows.map((row) => row.employerId),
        resultCount: rows.length,
      }, client);
      return rows;
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.analytics_slowest_employers',
      categories: ['analytics'],
      outcome: 'failed',
    });
    throw error;
  }
}

/**
 * Every stale job, for the tile's count; the list renders the first
 * STALE_JOBS_SHOWN through the same firstWithRest, and exactly those are
 * recorded: their employers and their number.
 */
export async function loadStaleJobs(session: AdminSession, days: StaleDays): Promise<StaleJob[]> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const rows = await getStaleJobs(client, days);
      const { shown } = firstWithRest(rows, STALE_JOBS_SHOWN);
      await recordAdminAccess(session, {
        surface: 'admin.analytics_stale_jobs',
        categories: ['analytics'],
        subjectUserIds: shown.map((job) => job.employerId),
        resultCount: shown.length,
      }, client);
      return rows;
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.analytics_stale_jobs',
      categories: ['analytics'],
      outcome: 'failed',
    });
    throw error;
  }
}

// ---- 2c: ops health (migration 115) ----
// The weeks picker reuses 2a's parseFunnelWeeks / FunnelWeeks (8 | 13 | 26).

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
  failed_last_24h: string | number;
  unresolved_older: string | number;
  oldest_stuck_at: PgTimestamp | null;
};

export function mapBillingInboxNowRow(row: BillingInboxNowRow): BillingInboxNow {
  return {
    stuckReceived: asCount(row.stuck_received),
    failedNow: asCount(row.failed_now),
    failedLast24h: asCount(row.failed_last_24h),
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

// ---- 2d: admin queues (migration 117) ----
// The weeks picker reuses 2a's parseFunnelWeeks / FunnelWeeks (8 | 13 | 26).

export type OnboardingRestartRow = {
  week_start: PgTimestamp | null;
  door: string;
  step_key: string | null;
  reached: string | number;
  restart_workers: string | number;
  restart_presses: string | number;
  back_workers: string | number;
  back_presses: string | number;
};

// Doors are a contract with migration 117, which computes 'all' itself: an
// unknown door is an error, never a row the page would silently drop.
export function mapOnboardingRestartRow(row: OnboardingRestartRow): OnboardingRestart {
  if (row.door !== 'all' && row.door !== 'whatsapp' && row.door !== 'web') {
    throw new Error(`Unexpected restarts door: ${row.door}`);
  }
  return {
    weekStart: asNullableIso(row.week_start),
    door: row.door,
    stepKey: row.step_key,
    reached: asCount(row.reached),
    restartWorkers: asCount(row.restart_workers),
    restartPresses: asCount(row.restart_presses),
    backWorkers: asCount(row.back_workers),
    backPresses: asCount(row.back_presses),
  };
}

export type OperatorResetRow = {
  week_start: PgTimestamp;
  reason: string;
  workers: string | number;
  resets: string | number;
  bulk: boolean;
  run_started_at: PgTimestamp | null;
};

export function mapOperatorResetRow(row: OperatorResetRow): OperatorReset {
  return {
    weekStart: asIso(row.week_start),
    reason: row.reason,
    workers: asCount(row.workers),
    resets: asCount(row.resets),
    bulk: row.bulk,
    runStartedAt: asNullableIso(row.run_started_at),
  };
}

export type DigestAdoptionRow = {
  employers: string | number;
  digest_on: string | number;
  digest_on_with_email: string | number;
};

export function mapDigestAdoptionRow(row: DigestAdoptionRow): DigestAdoption {
  return {
    employers: asCount(row.employers),
    digestOn: asCount(row.digest_on),
    digestOnWithEmail: asCount(row.digest_on_with_email),
  };
}

export type DigestSendsRow = {
  week_start: PgTimestamp | null;
  emailed: string | number;
  sent: string | number;
  failed: string | number;
  unknown: string | number;
  in_progress: string | number;
  employers_reached: string | number;
};

export function mapDigestSendsRow(row: DigestSendsRow): DigestSendsWeekly {
  return {
    weekStart: asNullableIso(row.week_start),
    emailed: asCount(row.emailed),
    sent: asCount(row.sent),
    failed: asCount(row.failed),
    unknown: asCount(row.unknown),
    inProgress: asCount(row.in_progress),
    employersReached: asCount(row.employers_reached),
  };
}

// Rows only where something happened, per (week, door, step) and per (week,
// door) for all steps (step_key NULL), plus the same for the whole window;
// restarts.ts splits them by door and step and zero-fills the weeks.
export async function getOnboardingRestarts(weeks: FunnelWeeks): Promise<OnboardingRestart[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<OnboardingRestartRow>(
    'SELECT * FROM admin_analytics_onboarding_restarts($1)',
    [weeks],
  );
  return result.rows.map(mapOnboardingRestartRow);
}

// Counted (week, reason) groups, then one row per bulk run.
export async function getOperatorResets(weeks: FunnelWeeks): Promise<OperatorReset[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<OperatorResetRow>(
    'SELECT * FROM admin_analytics_operator_resets($1)',
    [weeks],
  );
  return result.rows.map(mapOperatorResetRow);
}

// Exactly one row; a missing row is an error, never "digest on for 0%".
export async function getDigestAdoption(): Promise<DigestAdoption> {
  const pool = await getAdminDbPool();
  const result = await pool.query<DigestAdoptionRow>('SELECT * FROM admin_analytics_digest_adoption()');
  const row = result.rows[0];
  if (!row) {
    throw new Error('admin_analytics_digest_adoption() returned no row');
  }
  return mapDigestAdoptionRow(row);
}

// Every week of the window (zero-filled by SQL) plus the whole-window row.
export async function getDigestSends(weeks: FunnelWeeks): Promise<DigestSendsWeekly[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<DigestSendsRow>(
    'SELECT * FROM admin_analytics_digest_sends($1)',
    [weeks],
  );
  return result.rows.map(mapDigestSendsRow);
}

// ---- Sprint 28 contract K3.3: new analytics loaders (BE-3a owns the bodies) ----
// Step 0 stubs: real names, signatures and types, with typed empty data
// (empty series, zero counts, null for "nothing to measure"). Each loader
// runs one query once BE-3a fills it in. Every series follows K3.0: Monday
// 00:00 UTC weeks, oldest first, the last row possibly `partial`.

// Shares travel as percents 0-100, unrounded (the UI rounds); null when there
// is nothing to divide by (K3.0).
function percentShare(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

// Exactly one row from a one-row definer; a missing row is an error, never zeros.
function onlyRow<T>(rows: T[], fn: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`${fn}() returned no row`);
  }
  return row;
}

// #2
export type PayingWeek = { weekStart: string; partial: boolean; employers: number; paying: number; newPaying: number; churned: number };

export type PayingWeekRow = {
  week_start: PgTimestamp;
  partial: boolean;
  employers: string | number;
  paying: string | number;
  new_paying: string | number;
  churned: string | number;
  approximate_before: PgTimestamp | null;
};

export function mapPayingWeekRow(row: PayingWeekRow): PayingWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    employers: asCount(row.employers),
    paying: asCount(row.paying),
    newPaying: asCount(row.new_paying),
    churned: asCount(row.churned),
  };
}

// approximateBefore: the first live status change; earlier weeks rest on the
// one-time backfill (cancellations dated when they happened, nothing older).
export async function getPayingWeekly(weeks: number): Promise<{ weeks: PayingWeek[]; approximateBefore: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<PayingWeekRow>('SELECT * FROM admin_analytics_paying_weekly($1)', [weeks]);
  return {
    weeks: result.rows.map(mapPayingWeekRow),
    approximateBefore: result.rows.length === 0 ? null : asNullableIso(result.rows[0].approximate_before),
  };
}

// #5 (last 30 days; lockout resets come from the K2 reset action, operator resets from the CLI audit)
export type ResetReasonCount = { source: 'lockout_reset' | 'operator_reset'; reasonLabel: string; count: number };

export type ResetReasonRow = { source: string; reason_code: string | null; resets: string | number };

// The reset form's labels, without the form's own hint ("Other (add a note)").
const RESET_REASON_LABELS: ReadonlyMap<string, string> = new Map(
  LOCKOUT_RESET_REASONS.map(({ code, label }) => [code, label.replace(/ \([^)]*\)$/, '')]),
);

// Sources and codes are a contract with migration 123 and K2.6: an unknown
// one is an error, never a row the chart would mislabel.
export function mapResetReasonRow(row: ResetReasonRow): ResetReasonCount {
  if (row.source === 'operator_reset') {
    return { source: 'operator_reset', reasonLabel: 'Operator reset', count: asCount(row.resets) };
  }
  if (row.source !== 'lockout_reset') {
    throw new Error(`Unexpected reset source: ${row.source}`);
  }
  const label = row.reason_code === null ? undefined : RESET_REASON_LABELS.get(row.reason_code);
  if (label === undefined) {
    throw new Error(`Unexpected reset reason: ${row.reason_code}`);
  }
  return { source: 'lockout_reset', reasonLabel: label, count: asCount(row.resets) };
}

// Every lockout reason (zeros included) in the form's order, then operator resets.
export async function getResetReasons(days: 30): Promise<ResetReasonCount[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<ResetReasonRow>('SELECT * FROM admin_analytics_reset_reasons($1)', [days]);
  return result.rows.map(mapResetReasonRow);
}

// #6
export type CaseAgeBucket = { label: '<1h' | '1–4h' | '4–24h' | '1–3d' | '>3d'; waitingOnUs: number; waitingOnWorker: number };
export type CaseResolutionWeek = { weekStart: string; partial: boolean; resolved: number; medianHours: number | null; p75Hours: number | null };

export type CaseAgeRow = { bucket: string; waiting_on_us: string | number; waiting_on_worker: string | number };

const CASE_AGE_LABELS: Record<string, CaseAgeBucket['label']> = {
  under_1h: '<1h',
  '1_4h': '1–4h',
  '4_24h': '4–24h',
  '1_3d': '1–3d',
  over_3d: '>3d',
};

export function mapCaseAgeRow(row: CaseAgeRow): CaseAgeBucket {
  const label = Object.hasOwn(CASE_AGE_LABELS, row.bucket) ? CASE_AGE_LABELS[row.bucket] : undefined;
  if (label === undefined) {
    throw new Error(`Unexpected case age bucket: ${row.bucket}`);
  }
  return { label, waitingOnUs: asCount(row.waiting_on_us), waitingOnWorker: asCount(row.waiting_on_worker) };
}

export type CaseResolutionRow = {
  week_start: PgTimestamp;
  partial: boolean;
  resolved: string | number;
  median_hours: string | number | null;
  p75_hours: string | number | null;
};

export function mapCaseResolutionRow(row: CaseResolutionRow): CaseResolutionWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    resolved: asCount(row.resolved),
    medianHours: asNullableNumber(row.median_hours),
    p75Hours: asNullableNumber(row.p75_hours),
  };
}

// Open cases by time in their current status: five buckets, in order.
export async function getCaseAging(): Promise<CaseAgeBucket[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<CaseAgeRow>('SELECT * FROM admin_analytics_case_aging()');
  return result.rows.map(mapCaseAgeRow);
}

export async function getCaseResolution(weeks: number): Promise<CaseResolutionWeek[]> {
  const pool = await getAdminDbPool();
  const result = await pool.query<CaseResolutionRow>('SELECT * FROM admin_analytics_case_resolution($1)', [weeks]);
  return result.rows.map(mapCaseResolutionRow);
}

// #14
export type OnboardingStepRow = { stepKey: string; label: string; order: number; branch: boolean; reached: number; ofStarted: number | null; ofPrevious: number | null };

export type OnboardingStepsRow = {
  step_key: string;
  step_order: number;
  branch: boolean;
  reached: string | number;
  started: string | number;
};

// Of started, and of the nearest earlier main-line step: a branch step is
// measured against the step it forks from, and the step after a branch skips
// it. The first step has no previous.
export function onboardingStepRows(rows: OnboardingStepsRow[]): { started: number; steps: OnboardingStepRow[] } {
  const started = rows.length === 0 ? 0 : asCount(rows[0].started);
  let previousMain: number | null = null;
  const steps = rows.map((row): OnboardingStepRow => {
    const reached = asCount(row.reached);
    const step: OnboardingStepRow = {
      stepKey: row.step_key,
      label: stepLabel(row.step_key),
      order: row.step_order,
      branch: row.branch,
      reached,
      ofStarted: percentShare(reached, started),
      ofPrevious: previousMain === null ? null : percentShare(reached, previousMain),
    };
    if (!row.branch) previousMain = reached;
    return step;
  });
  return { started, steps };
}

export async function getOnboardingSteps(weeks: number, door: 'all' | 'whatsapp' | 'web'): Promise<{ started: number; steps: OnboardingStepRow[] }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<OnboardingStepsRow>('SELECT * FROM admin_analytics_onboarding_steps($1, $2)', [weeks, door]);
  return onboardingStepRows(result.rows);
}

// #15 (WhatsApp door only; timings exclude backfilled history)
export type IdentityFunnel = {
  challenges: number; reachedCode: number; verified: number; lockedOnce: number; expiredUnused: number;
  attempts: { zero: number; one: number; two: number; threePlus: number };
  medianMinutesToVerify: number | null; p75MinutesToVerify: number | null; timingsSince: string | null;
};

export type IdentityFunnelRow = {
  challenges: string | number;
  reached_code: string | number;
  verified: string | number;
  locked_once: string | number;
  expired_unused: string | number;
  attempts_zero: string | number;
  attempts_one: string | number;
  attempts_two: string | number;
  attempts_three_plus: string | number;
  median_minutes_to_verify: string | number | null;
  p75_minutes_to_verify: string | number | null;
  timings_since: PgTimestamp | null;
};

export function mapIdentityFunnelRow(row: IdentityFunnelRow): IdentityFunnel {
  return {
    challenges: asCount(row.challenges),
    reachedCode: asCount(row.reached_code),
    verified: asCount(row.verified),
    lockedOnce: asCount(row.locked_once),
    expiredUnused: asCount(row.expired_unused),
    attempts: {
      zero: asCount(row.attempts_zero),
      one: asCount(row.attempts_one),
      two: asCount(row.attempts_two),
      threePlus: asCount(row.attempts_three_plus),
    },
    medianMinutesToVerify: asNullableNumber(row.median_minutes_to_verify),
    p75MinutesToVerify: asNullableNumber(row.p75_minutes_to_verify),
    timingsSince: asNullableIso(row.timings_since),
  };
}

export async function getIdentityFunnel(weeks: number): Promise<IdentityFunnel> {
  const pool = await getAdminDbPool();
  const result = await pool.query<IdentityFunnelRow>('SELECT * FROM admin_analytics_identity_funnel($1)', [weeks]);
  return mapIdentityFunnelRow(onlyRow(result.rows, 'admin_analytics_identity_funnel'));
}

// #16
export type AcquisitionSource = 'shared_link' | 'campaign_tag' | 'referral' | 'direct' | 'whatsapp_entry' | 'unknown';
export type AcquisitionWeek = { weekStart: string; partial: boolean; bySource: Record<AcquisitionSource, number>; total: number };
export type AcquisitionRow = {
  week_start: PgTimestamp;
  partial: boolean;
  from_shared_link: string | number;
  from_campaign_tag: string | number;
  from_referral: string | number;
  from_direct: string | number;
  from_whatsapp_entry: string | number;
  from_unknown: string | number;
  total: string | number;
  collecting_since: PgTimestamp | null;
};

export function mapAcquisitionRow(row: AcquisitionRow): AcquisitionWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    bySource: {
      shared_link: asCount(row.from_shared_link),
      campaign_tag: asCount(row.from_campaign_tag),
      referral: asCount(row.from_referral),
      direct: asCount(row.from_direct),
      whatsapp_entry: asCount(row.from_whatsapp_entry),
      unknown: asCount(row.from_unknown),
    },
    total: asCount(row.total),
  };
}

// Migration 124's definers repeat their "since" column on every row; NULL
// (nothing recorded yet) stays null, as does an empty result.
function sinceOf<T>(rows: T[], pick: (row: T) => PgTimestamp | null): string | null {
  return rows.length === 0 ? null : asNullableIso(pick(rows[0]));
}

export async function getAcquisition(weeks: number): Promise<{ weeks: AcquisitionWeek[]; collectingSince: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<AcquisitionRow>('SELECT * FROM admin_analytics_acquisition($1)', [weeks]);
  return { weeks: result.rows.map(mapAcquisitionRow), collectingSince: sinceOf(result.rows, (row) => row.collecting_since) };
}

// #17
export type JobViewWeek = { weekStart: string; partial: boolean; publicOpens: number; publicApplications: number; workerViews: number; workerViewApplications: number };
// collectingSince covers worker views; public opens already have history.
export type JobViewRow = {
  week_start: PgTimestamp;
  partial: boolean;
  public_opens: string | number;
  public_applications: string | number;
  worker_views: string | number;
  worker_view_applications: string | number;
  collecting_since: PgTimestamp | null;
};

export function mapJobViewRow(row: JobViewRow): JobViewWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    publicOpens: asCount(row.public_opens),
    publicApplications: asCount(row.public_applications),
    workerViews: asCount(row.worker_views),
    workerViewApplications: asCount(row.worker_view_applications),
  };
}

export async function getJobViewFunnel(weeks: number): Promise<{ weeks: JobViewWeek[]; collectingSince: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<JobViewRow>('SELECT * FROM admin_analytics_job_views($1)', [weeks]);
  return { weeks: result.rows.map(mapJobViewRow), collectingSince: sinceOf(result.rows, (row) => row.collecting_since) };
}

// #18
export type TemplateReuseWeek = { weekStart: string; partial: boolean; jobs: number; fromTemplate: number; employersUsingTemplates: number; templatesSaved: number };
export type TemplateReuseRow = {
  week_start: PgTimestamp;
  partial: boolean;
  jobs: string | number;
  from_template: string | number;
  employers_using_templates: string | number;
  templates_saved: string | number;
  collecting_since: PgTimestamp | null;
};

export function mapTemplateReuseRow(row: TemplateReuseRow): TemplateReuseWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    jobs: asCount(row.jobs),
    fromTemplate: asCount(row.from_template),
    employersUsingTemplates: asCount(row.employers_using_templates),
    templatesSaved: asCount(row.templates_saved),
  };
}

export async function getTemplateReuse(weeks: number): Promise<{ weeks: TemplateReuseWeek[]; collectingSince: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<TemplateReuseRow>('SELECT * FROM admin_analytics_template_reuse($1)', [weeks]);
  return { weeks: result.rows.map(mapTemplateReuseRow), collectingSince: sinceOf(result.rows, (row) => row.collecting_since) };
}

// #19 (current state; no history exists)
export type RankingFreshness = {
  buckets: { label: '<1h' | '1–6h' | '6–24h' | '1–3d' | '>3d'; jobs: number }[];
  jobsOlderThan24h: number; fallbackShare: number | null; fallbackJobs: number; rankedJobs: number; jobsWithApplicationsButNoRanking: number;
};

export type RankingFreshnessRow = {
  under_1h: string | number;
  from_1h_to_6h: string | number;
  from_6h_to_24h: string | number;
  from_1d_to_3d: string | number;
  over_3d: string | number;
  ranked_jobs: string | number;
  fallback_jobs: string | number;
  jobs_with_applications_no_ranking: string | number;
};

export function mapRankingFreshnessRow(row: RankingFreshnessRow): RankingFreshness {
  const buckets: RankingFreshness['buckets'] = [
    { label: '<1h', jobs: asCount(row.under_1h) },
    { label: '1–6h', jobs: asCount(row.from_1h_to_6h) },
    { label: '6–24h', jobs: asCount(row.from_6h_to_24h) },
    { label: '1–3d', jobs: asCount(row.from_1d_to_3d) },
    { label: '>3d', jobs: asCount(row.over_3d) },
  ];
  const rankedJobs = asCount(row.ranked_jobs);
  const fallbackJobs = asCount(row.fallback_jobs);
  return {
    buckets,
    // The ranking cache lives 24 hours: the last two buckets are past it.
    jobsOlderThan24h: buckets[3].jobs + buckets[4].jobs,
    fallbackShare: percentShare(fallbackJobs, rankedJobs),
    fallbackJobs,
    rankedJobs,
    jobsWithApplicationsButNoRanking: asCount(row.jobs_with_applications_no_ranking),
  };
}

export async function getRankingFreshness(): Promise<RankingFreshness> {
  const pool = await getAdminDbPool();
  const result = await pool.query<RankingFreshnessRow>('SELECT * FROM admin_analytics_ranking_freshness()');
  return mapRankingFreshnessRow(onlyRow(result.rows, 'admin_analytics_ranking_freshness'));
}

// #20
export type MatchWeek = { weekStart: string; partial: boolean; channel: 'web' | 'whatsapp'; shown: number; appliedWithin7d: number };
export type MatchRow = {
  week_start: PgTimestamp;
  partial: boolean;
  channel: string;
  shown: string | number;
  applied_within_7d: string | number;
  collecting_since: PgTimestamp | null;
};

// Channels are a contract with migration 124: an unknown one is an error,
// never a row the page would silently mislabel.
export function mapMatchRow(row: MatchRow): MatchWeek {
  if (row.channel !== 'web' && row.channel !== 'whatsapp') {
    throw new Error(`Unexpected match channel: ${row.channel}`);
  }
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    channel: row.channel,
    shown: asCount(row.shown),
    appliedWithin7d: asCount(row.applied_within_7d),
  };
}

// Two rows per week (web, then WhatsApp), oldest week first.
export async function getMatchToApply(weeks: number): Promise<{ weeks: MatchWeek[]; collectingSince: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<MatchRow>('SELECT * FROM admin_analytics_match_to_apply($1)', [weeks]);
  return { weeks: result.rows.map(mapMatchRow), collectingSince: sinceOf(result.rows, (row) => row.collecting_since) };
}

// #21 (apply intents and claims come from daily snapshots, so history survives the token purge)
export type ReferralWeek = { weekStart: string; partial: boolean; opens: number; applyIntents: number; claims: number; applications: number; hires: number };
export type ReferralRow = {
  week_start: PgTimestamp;
  partial: boolean;
  opens: string | number;
  apply_intents: string | number;
  claims: string | number;
  applications: string | number;
  hires: string | number;
  snapshots_since: PgTimestamp | null;
};

export function mapReferralRow(row: ReferralRow): ReferralWeek {
  return {
    weekStart: asIso(row.week_start),
    partial: row.partial,
    opens: asCount(row.opens),
    applyIntents: asCount(row.apply_intents),
    claims: asCount(row.claims),
    applications: asCount(row.applications),
    hires: asCount(row.hires),
  };
}

// Weeks before snapshotsSince carry 0 apply intents and claims (no snapshot).
export async function getReferralFunnel(weeks: number): Promise<{ weeks: ReferralWeek[]; snapshotsSince: string | null }> {
  const pool = await getAdminDbPool();
  const result = await pool.query<ReferralRow>('SELECT * FROM admin_analytics_referral_funnel($1)', [weeks]);
  return { weeks: result.rows.map(mapReferralRow), snapshotsSince: sinceOf(result.rows, (row) => row.snapshots_since) };
}

// #11 (live; one failing queue never fails the page). Queue labels are plain
// words ("WhatsApp inbound", "Billing webhooks", ...), never queue names.
export type DlqDepth = { queues: { label: string; visible: number | null; inFlight: number | null; unavailable: boolean }[]; totalVisible: number | null };
export async function getDlqDepth(): Promise<DlqDepth> {
  return readDlqDepth();
}

// ---- Sprint 28 contract K3.4: Home metrics and health (BE-3a owns the bodies) ----
export type HomeMetrics = {
  signupsTotal: number; signupsThisWeek: number;
  payingEmployers: number; payingThisWeek: number;
  hiresLast30d: number; jobsWithHireLast30d: number;
  openJobs: number; staleJobs14d: number;
  signupsWeekly: { weekStart: string; partial: boolean; cumulative: number }[];   // last 8 weeks, for the Home chart
};

// The Home scalars in one statement: totals (088/113, every account, as the
// Growth KPI strip), this week's new paying employers (123) and the 30-day
// hires and 14-day stale jobs (123, test accounts left out).
export const HOME_METRICS_SQL = `
  SELECT t.total_workers, t.total_employers, t.paying_employers, t.jobs_active,
         p.new_paying AS paying_new_this_week,
         h.hires_last_30d, h.jobs_with_hire_last_30d, h.stale_jobs_14d
    FROM admin_analytics_totals() t
    CROSS JOIN admin_analytics_paying_weekly(1) p
    CROSS JOIN admin_analytics_home_metrics() h`;

export type HomeMetricsRow = {
  total_workers: string | number;
  total_employers: string | number;
  paying_employers: string | number;
  jobs_active: string | number;
  paying_new_this_week: string | number;
  hires_last_30d: string | number;
  jobs_with_hire_last_30d: string | number;
  stale_jobs_14d: string | number;
};

export const HOME_SIGNUP_WEEKS = 8;

// Two statements, one after the other, so the loader never holds more than
// one pool connection. The weekly series is the last 8 weeks of signups
// (workers and employers) as a running total ending at today's total.
export async function getHomeMetrics(now: Date = new Date()): Promise<HomeMetrics> {
  const pool = await getAdminDbPool();
  const scalars = await pool.query<HomeMetricsRow>(HOME_METRICS_SQL);
  const row = scalars.rows[0];
  if (!row) {
    throw new Error('Home metrics returned no row');
  }
  const { from, bucket } = resolveRange(HOME_SIGNUP_WEEKS, now);
  const signups = await pool.query<SignupRow>('SELECT * FROM admin_analytics_signups($1, $2)', [from, bucket]);
  const weekly = fillBuckets(
    signups.rows.map(mapSignupRow),
    bucketStarts(from, bucket, now),
    (bucketStart) => ({ bucketStart, workerSignups: 0, employerSignups: 0, workerSignupsVerified: 0 }),
  );
  const perWeek = weekly.map((week) => week.workerSignups + week.employerSignups);
  const signupsTotal = asCount(row.total_workers) + asCount(row.total_employers);
  const cumulative = cumulativeSeries(perWeek, signupsTotal);
  return {
    signupsTotal,
    signupsThisWeek: perWeek.length === 0 ? 0 : perWeek[perWeek.length - 1],
    payingEmployers: asCount(row.paying_employers),
    payingThisWeek: asCount(row.paying_new_this_week),
    hiresLast30d: asCount(row.hires_last_30d),
    jobsWithHireLast30d: asCount(row.jobs_with_hire_last_30d),
    openJobs: asCount(row.jobs_active),
    staleJobs14d: asCount(row.stale_jobs_14d),
    signupsWeekly: weekly.map((week, i) => ({
      weekStart: week.bucketStart,
      partial: i === weekly.length - 1,
      cumulative: cumulative[i],
    })),
  };
}

export type HealthState = 'healthy' | 'watch' | 'problem' | 'unknown';
export type HealthItem = {
  key: 'whatsapp_delivery' | 'message_backlog' | 'billing_webhooks' | 'email_bounces' | 'email_feedback' | 'ai_extraction';
  label: string;   // "WhatsApp delivery"
  value: string;   // "0 failed sends", "0 queued · 0 dead-lettered", "1 bounce", "97% complete"
  state: HealthState;
};

// The figures the health strip judges. null = the source could not be read.
export type SystemHealthInputs = {
  whatsappFailed24h: number | null;
  queuedOver1h: number | null;
  stuckMessages: number | null;
  dlqVisible: number | null;
  billingFailed24h: number | null;
  sesBounces24h: number | null;
  /** Messages in the SES feedback dead-letter queue; undefined when that queue is not configured. */
  sesFeedbackDlqVisible: number | null | undefined;
  aiFinished7d: number | null;
  aiUsable7d: number | null;
};

// Thresholds (BE-3a spec §4.4; Luis may tune them). Each is the smallest value
// that reaches the band.
export const HEALTH_THRESHOLDS = {
  whatsappFailedWatch: 1,
  whatsappFailedProblem: 5,
  sesBouncesWatch: 1,
  sesBouncesProblem: 3,
  aiUsableHealthyPercent: 95,
  aiUsableWatchPercent: 85,
} as const;

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const part = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'));
const UNAVAILABLE = 'unavailable';

export function systemHealthItems(input: SystemHealthInputs): HealthItem[] {
  const t = HEALTH_THRESHOLDS;
  const items: HealthItem[] = [];

  const failed = input.whatsappFailed24h;
  items.push({
    key: 'whatsapp_delivery',
    label: 'WhatsApp delivery',
    value: failed === null ? UNAVAILABLE : plural(failed, 'failed send', 'failed sends'),
    state: failed === null ? 'unknown'
      : failed >= t.whatsappFailedProblem ? 'problem'
        : failed >= t.whatsappFailedWatch ? 'watch' : 'healthy',
  });

  const { stuckMessages: stuck, queuedOver1h: queued, dlqVisible: dlq } = input;
  items.push({
    key: 'message_backlog',
    label: 'Message backlog',
    value: `${part(stuck)} stuck · ${part(queued)} queued over 1 h · ${part(dlq)} dead-lettered`,
    state: stuck === null || queued === null || dlq === null ? 'unknown'
      : stuck > 0 || dlq > 0 ? 'problem'
        : queued > 0 ? 'watch' : 'healthy',
  });

  const billing = input.billingFailed24h;
  items.push({
    key: 'billing_webhooks',
    label: 'Billing webhooks',
    value: billing === null ? UNAVAILABLE : plural(billing, 'failed event', 'failed events'),
    state: billing === null ? 'unknown' : billing > 0 ? 'problem' : 'healthy',
  });

  const bounces = input.sesBounces24h;
  items.push({
    key: 'email_bounces',
    label: 'Email bounces',
    value: bounces === null ? UNAVAILABLE : plural(bounces, 'bounce', 'bounces'),
    state: bounces === null ? 'unknown'
      : bounces >= t.sesBouncesProblem ? 'problem'
        : bounces >= t.sesBouncesWatch ? 'watch' : 'healthy',
  });

  // Bounce and complaint events the feedback handler could not process.
  const feedback = input.sesFeedbackDlqVisible;
  items.push({
    key: 'email_feedback',
    label: 'Email feedback',
    value: feedback === undefined ? 'not configured' : feedback === null ? UNAVAILABLE : `${part(feedback)} dead-lettered`,
    state: feedback === undefined || feedback === null ? 'unknown' : feedback > 0 ? 'problem' : 'healthy',
  });

  const { aiFinished7d: finished, aiUsable7d: usable } = input;
  let ai: Pick<HealthItem, 'value' | 'state'>;
  if (finished === null || usable === null) {
    ai = { value: UNAVAILABLE, state: 'unknown' };
  } else if (finished === 0) {
    // Nothing to measure is not a fault.
    ai = { value: 'no voice notes in 7 days', state: 'healthy' };
  } else {
    const share = (usable / finished) * 100;
    // Rounded down, so the printed share never sits in a better band.
    ai = {
      value: `${Math.floor(share)}% usable (7 days)`,
      state: share >= t.aiUsableHealthyPercent ? 'healthy' : share >= t.aiUsableWatchPercent ? 'watch' : 'problem',
    };
  }
  items.push({ key: 'ai_extraction', label: 'AI extraction', ...ai });

  return items;
}

// One statement for the database figures: the 24 h / 7 day counts (123), the
// message backlog (115) and the billing inbox (115, failed_last_24h from 123).
export const SYSTEM_HEALTH_SQL = `
  SELECT h.whatsapp_failed_24h, h.ai_finished_7d, h.ai_usable_7d,
         b.queued_over_1h, b.stuck_messages, n.failed_last_24h AS billing_failed_24h
    FROM admin_analytics_system_health() h
    CROSS JOIN (SELECT COALESCE(sum(m.open_1_24h + m.open_24_48h), 0) AS queued_over_1h,
                       COALESCE(sum(m.stuck), 0) AS stuck_messages
                  FROM admin_analytics_message_backlog() m) b
    CROSS JOIN admin_analytics_billing_inbox_now() n`;

export type SystemHealthRow = {
  whatsapp_failed_24h: string | number;
  ai_finished_7d: string | number;
  ai_usable_7d: string | number;
  queued_over_1h: string | number;
  stuck_messages: string | number;
  billing_failed_24h: string | number;
};

async function readSystemHealthRow(): Promise<SystemHealthRow | null> {
  try {
    const pool = await getAdminDbPool();
    const result = await pool.query<SystemHealthRow>(SYSTEM_HEALTH_SQL);
    return result.rows[0] ?? null;
  } catch (error) {
    // The strip shows the database items as unknown; the page still renders.
    console.error(JSON.stringify({
      metric: 'AdminHealthSourceUnavailable',
      source: 'database',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    return null;
  }
}

// AdminStack sets ADMIN_SES_FEEDBACK_DLQ_URL only when the SES feedback
// dead-letter queue exists. Unset, the queue is not configured and not read.
function sesFeedbackDlqQueues(url: string | undefined = process.env.ADMIN_SES_FEEDBACK_DLQ_URL): DlqQueue[] {
  return url ? [{ label: 'Email feedback', url }] : [];
}

// Never throws: a source that cannot be read makes its items unknown.
export async function getSystemHealth(): Promise<{ items: HealthItem[]; windowLabel: 'last 24 hours' }> {
  const feedbackQueues = sesFeedbackDlqQueues();
  const [row, dlq, bounces, feedback] = await Promise.all([
    readSystemHealthRow(),
    readDlqDepth(),
    readSesBounces24h(),
    feedbackQueues.length > 0 ? readDlqDepth(feedbackQueues) : undefined,
  ]);
  const count = (value: string | number | undefined): number | null => (row && value !== undefined ? asCount(value) : null);
  const items = systemHealthItems({
    whatsappFailed24h: count(row?.whatsapp_failed_24h),
    queuedOver1h: count(row?.queued_over_1h),
    stuckMessages: count(row?.stuck_messages),
    dlqVisible: dlq.totalVisible,
    billingFailed24h: count(row?.billing_failed_24h),
    sesBounces24h: bounces,
    sesFeedbackDlqVisible: feedback === undefined ? undefined : feedback.totalVisible,
    aiFinished7d: count(row?.ai_finished_7d),
    aiUsable7d: count(row?.ai_usable_7d),
  });
  return { items, windowLabel: 'last 24 hours' };
}
