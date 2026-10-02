import type { AnalyticsRange, PayingEmployer, SignupsView } from './types';

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

// Range and signups-view links each preserve the other; the default view
// ('total') is left out so existing ?range= links keep their meaning.
export function analyticsHref(range: AnalyticsRange, signups: SignupsView): string {
  return signups === 'new' ? `/analytics?range=${range}&signups=new` : `/analytics?range=${range}`;
}

export function periodEndLabel(row: PayingEmployer): string {
  if (!row.currentPeriodEnd) return '—';
  const day = shortDate(row.currentPeriodEnd);
  if (row.cancelAtPeriodEnd) return `Cancels ${day}`;
  if (row.status === 'trialing') return `Trial ends ${day}`;
  if (row.status === 'past_due') return `Due ${day}`;
  return `Renews ${day}`;
}
