import type { AnalyticsBucket, AnalyticsRange } from '../types';

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
