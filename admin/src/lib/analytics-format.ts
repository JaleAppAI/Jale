import type { AnalyticsRange, PayingEmployer } from './types';

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

export function periodEndLabel(row: PayingEmployer): string {
  if (!row.currentPeriodEnd) return '—';
  const day = shortDate(row.currentPeriodEnd);
  if (row.cancelAtPeriodEnd) return `Cancels ${day}`;
  if (row.status === 'trialing') return `Trial ends ${day}`;
  if (row.status === 'past_due') return `Due ${day}`;
  return `Renews ${day}`;
}
