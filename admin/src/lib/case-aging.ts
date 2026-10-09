import type { AdminCase, AdminCaseStatus } from './types';

// Roadmap 2d: case aging. Pure helpers for /cases, the case page and Home.
// "Waiting" is the time since the case entered its current status
// (admin_cases.status_changed_at, migration 117); "opened" is created_at.
// Dates print in UTC, like the analytics pages.

export type WaitingOn = 'us' | 'worker' | 'closed';

// Labels match the status badges and the "Status changed" timeline entries.
const STATUSES: Record<AdminCaseStatus, { label: string; waitingOn: WaitingOn }> = {
  open: { label: 'Open', waitingOn: 'us' },
  pending_admin: { label: 'Pending admin', waitingOn: 'us' },
  pending_worker: { label: 'Pending worker', waitingOn: 'worker' },
  resolved: { label: 'Resolved', waitingOn: 'closed' },
  dismissed: { label: 'Dismissed', waitingOn: 'closed' },
};

function statusInfo(status: AdminCaseStatus): { label: string; waitingOn: WaitingOn } {
  if (!Object.hasOwn(STATUSES, status)) throw new Error(`Unexpected case status: ${status}`);
  return STATUSES[status];
}

// Open and Pending admin wait on an admin; Pending worker waits on the worker.
export function waitingOn(status: AdminCaseStatus): WaitingOn {
  return statusInfo(status).waitingOn;
}

export function statusLabel(status: AdminCaseStatus): string {
  return statusInfo(status).label;
}

// ---- Home: open cases by wait ------------------------------------------------
// Bucket ids are the SQL's (countOpenCasesByWait); edges on now() - status_changed_at:
// [0, 24 h), [24 h, 72 h), [72 h, 168 h), [168 h, ∞).
export type WaitBucket = 'under_1d' | 'days_1_3' | 'days_3_7' | 'over_7d';
export type WaitCounts = Record<WaitBucket, number>;
export type OpenCasesByWait = { us: WaitCounts; worker: WaitCounts };

export const WAIT_BUCKETS: readonly { id: WaitBucket; label: string }[] = [
  { id: 'under_1d', label: 'Under 1 day' },
  { id: 'days_1_3', label: '1–3 days' },
  { id: 'days_3_7', label: '3–7 days' },
  { id: 'over_7d', label: 'Over 7 days' },
];

export const WAIT_ROWS: readonly { id: keyof OpenCasesByWait; label: string }[] = [
  { id: 'us', label: 'Waiting on us' },
  { id: 'worker', label: 'Waiting on worker' },
];

export function waitTotal(counts: WaitCounts): number {
  return WAIT_BUCKETS.reduce((total, bucket) => total + counts[bucket.id], 0);
}

export function openCasesTotal(byWait: OpenCasesByWait): number {
  return waitTotal(byWait.us) + waitTotal(byWait.worker);
}

// The Open cases tile note.
export function waitingOnUsNote(byWait: OpenCasesByWait): string {
  return `${waitTotal(byWait.us).toLocaleString('en-US')} waiting on us`;
}

// ---- Durations and dates -------------------------------------------------------
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

// Whole units, rounded down: minutes under an hour (at least 1 min, also for a
// time ahead of the server clock), hours under a day, days under 14 days, then weeks.
export function formatWait(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))} min`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h`;
  if (ms < 14 * DAY_MS) return count(Math.floor(ms / DAY_MS), 'day');
  return count(Math.floor(ms / WEEK_MS), 'week');
}

// "Oct 3" in UTC; "Dec 31, 2025" when the year is not the current UTC year.
export function formatCaseDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getUTCFullYear() === now.getUTCFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

// ---- Line text ---------------------------------------------------------------
export type CaseTimes = Pick<AdminCase, 'status' | 'createdAt' | 'statusChangedAt'>;

const elapsed = (iso: string, now: Date): string => formatWait(now.getTime() - Date.parse(iso));

// A closed case shows when it closed: "Resolved Oct 7" / "Dismissed Oct 7".
const closedLine = (item: CaseTimes, now: Date): string =>
  `${statusLabel(item.status)} ${formatCaseDate(item.statusChangedAt, now)}`;

// /cases: "Opened Oct 3 · 6 days ago".
export function caseOpenedLine(item: CaseTimes, now: Date = new Date()): string {
  return `Opened ${formatCaseDate(item.createdAt, now)} · ${elapsed(item.createdAt, now)} ago`;
}

// /cases: "Waiting on us for 2 days" / "Waiting on worker for 5 h" / "Resolved Oct 7".
export function caseWaitLine(item: CaseTimes, now: Date = new Date()): string {
  const on = waitingOn(item.status);
  return on === 'closed' ? closedLine(item, now) : `Waiting on ${on} for ${elapsed(item.statusChangedAt, now)}`;
}

// Case page: "Opened Oct 3 (6 days ago)".
export function caseOpenedMeta(item: CaseTimes, now: Date = new Date()): string {
  return `Opened ${formatCaseDate(item.createdAt, now)} (${elapsed(item.createdAt, now)} ago)`;
}

// Case page: "Pending worker for 5 h" while open; "Resolved Oct 7" once closed.
export function caseStatusMeta(item: CaseTimes, now: Date = new Date()): string {
  return waitingOn(item.status) === 'closed'
    ? closedLine(item, now)
    : `${statusLabel(item.status)} for ${elapsed(item.statusChangedAt, now)}`;
}

// Home open-queue preview: "waiting 2 days" (the badge beside it says on whom).
// The preview lists open cases only; a closed case would read as on /cases.
export function casePreviewWait(item: CaseTimes, now: Date = new Date()): string {
  return waitingOn(item.status) === 'closed' ? closedLine(item, now) : `waiting ${elapsed(item.statusChangedAt, now)}`;
}
