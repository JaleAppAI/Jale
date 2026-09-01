import type {
  AnalyticsBucket,
  AnalyticsRange,
  AnalyticsTotals,
  JobsActivityBucket,
  MessageTrafficBucket,
  PayingEmployer,
  SignupBucket,
} from '../types';
import { getAdminDbPool } from './db';

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = '30d';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseAnalyticsRange(value: unknown): AnalyticsRange {
  return value === '7d' || value === '30d' || value === '90d' ? value : DEFAULT_ANALYTICS_RANGE;
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
  };
}

export type SignupRow = {
  bucket_start: PgTimestamp;
  worker_signups: string | number;
  employer_signups: string | number;
};

export function mapSignupRow(row: SignupRow): SignupBucket {
  return {
    bucketStart: asIso(row.bucket_start),
    workerSignups: asCount(row.worker_signups),
    employerSignups: asCount(row.employer_signups),
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
    (bucketStart) => ({ bucketStart, workerSignups: 0, employerSignups: 0 }),
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
