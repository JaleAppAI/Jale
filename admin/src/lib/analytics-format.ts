import type { AnalyticsRange, PayingEmployer, SignupsView } from './types';

// Contract K3.0 (sprint 28): the "collecting since" date for the tracked-from-
// now panels: the date sprint 28's capture started.
export const ANALYTICS_RELEASE_LABEL: string = 'Oct 16, 2026';

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function bucketLabel(iso: string, range: AnalyticsRange): string {
  const day = shortDate(iso);
  return range === '90d' ? `Week of ${day}` : day;
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function signedDelta(n: number): string {
  if (n > 0) return `+${formatCount(n)}`;
  if (n < 0) return `−${formatCount(Math.abs(n))}`;
  return '0';
}

export function percentOf(part: number, whole: number, digits = 0): string | null {
  if (whole <= 0) return null;
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function perUnit(total: number, units: number, digits = 1): string | null {
  if (units <= 0) return null;
  return (total / units).toFixed(digits);
}

// Running total per bucket. `total` is today's all-time count and includes
// every signup in the window, so the count before the window is
// total − sum(window). Clamped at 0: totals and signups are read in separate
// query waves, and a deletion between them must not push the baseline negative.
export function cumulativeSeries(perBucket: number[], total: number): number[] {
  const values: number[] = [];
  let running = Math.max(0, total - sum(perBucket));
  for (const value of perBucket) {
    running += value;
    values.push(running);
  }
  return values;
}

export function periodEndLabel(row: PayingEmployer): string {
  if (!row.currentPeriodEnd) return '—';
  const day = shortDate(row.currentPeriodEnd);
  if (row.cancelAtPeriodEnd) return `Cancels ${day}`;
  if (row.status === 'trialing') return `Trial ends ${day}`;
  if (row.status === 'past_due') return `Due ${day}`;
  return `Renews ${day}`;
}

// ---- D11 (Sprint 28) ----
// A week's x label: the Monday it starts on, "Aug 24" (the axis title says "Week starting").
export function weekLabel(iso: string): string {
  return shortDate(iso);
}

// A whole-percent share that never rounds a fact away: some but not all of
// the whole reads "<1%" or ">99%", never "0%" or "100%". Nothing to divide
// by is a dash. (Moved here from ops-health.ts, which re-exports it.)
export function wholePercent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const share = Math.round((part * 100) / whole);
  if (share === 0 && part > 0) return '<1%';
  if (share === 100 && part < whole) return '>99%';
  return `${share}%`;
}

// A rate for a chart point, in percent with one decimal, that never rounds a
// fact away (0.1 for "some", 99.9 for "almost all"). Nothing to divide by is
// null: a gap, never 0.
export function shareRate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const rate = Math.round((part * 1000) / whole) / 10;
  if (rate === 0 && part > 0) return 0.1;
  if (rate === 100 && part < whole) return 99.9;
  return rate;
}

// A rate as text, at most one decimal: 12, 12.5, 0.1.
export function formatRate(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// A funnel stage: "62% · 1,240", the share of the base (the first stage).
export function funnelLabel(count: number, base: number): string {
  return `${wholePercent(count, base)} · ${formatCount(count)}`;
}

// Weekly K3 rows, oldest first (K3.0 sends them so; sorting keeps it true).
export function oldestFirst<T extends { weekStart: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
}

// The x labels of oldest-first weekly rows, and whether the last one is the
// partial current week (drawn hollow).
export function weeklyAxis(rows: { weekStart: string; partial: boolean }[]): { labels: string[]; partialLast: boolean } {
  return {
    labels: rows.map((row) => weekLabel(row.weekStart)),
    partialLast: rows.length > 0 && rows[rows.length - 1].partial,
  };
}

// The Growth tab's links: the range and the signups view keep each other; the
// default view ('total') is left out.
export function growthHref(weeks: number, signups: SignupsView): string {
  return signups === 'new' ? `/analytics?weeks=${weeks}&signups=new` : `/analytics?weeks=${weeks}`;
}
