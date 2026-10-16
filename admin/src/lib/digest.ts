import { formatCount, weekLabel, wholePercent } from './analytics-format';
import { isCurrentWeek, newestWeeksFirst } from './ops-health';
import type { DigestAdoption, DigestSendFigures, DigestSendsWeekly } from './types';

// "Digest on for 12% of employers (34 of 280) · 29 of them have an email
// address". The share never rounds a fact away (<1%, >99%); with no
// employers it is a dash, and with none on the email part is left out.
export function adoptionLine(adoption: DigestAdoption): string {
  const share = wholePercent(adoption.digestOn, adoption.employers);
  const line = `Digest on for ${share} of employers (${formatCount(adoption.digestOn)} of ${formatCount(adoption.employers)})`;
  if (adoption.digestOn === 0) return line;
  const verb = adoption.digestOnWithEmail === 1 ? 'has' : 'have';
  return `${line} · ${formatCount(adoption.digestOnWithEmail)} of them ${verb} an email address`;
}

export type DigestWeek = DigestSendFigures & { weekStart: string };
export type DigestSplit = { weekly: DigestWeek[]; window: DigestSendFigures };

const ZERO_SENDS: DigestSendFigures = {
  emailed: 0,
  sent: 0,
  failed: 0,
  unknown: 0,
  inProgress: 0,
  employersReached: 0,
};

// weekly: every week of the window (SQL zero-fills them), oldest first.
// window: the SQL whole-window row, never a sum of the weeks (employers
// reached is distinct across the window); all zeros if it is missing.
export function splitDigestSends(rows: DigestSendsWeekly[]): DigestSplit {
  const weekly: DigestWeek[] = [];
  let window: DigestSendFigures = { ...ZERO_SENDS };
  for (const { weekStart, ...figures } of rows) {
    if (weekStart === null) window = figures;
    else weekly.push({ ...figures, weekStart });
  }
  weekly.sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  return { weekly, window };
}

export type DigestTableRow = DigestWeek & { label: string; current: boolean };

// Table rows newest first; the current week is still in progress ("so far").
// The total row is `window`.
export function digestTableRows(split: DigestSplit, now: Date = new Date()): DigestTableRow[] {
  return newestWeeksFirst(split.weekly, now);
}

// Nothing emailed in these weeks: the table gives way to the empty state.
export function digestEmpty(split: DigestSplit): boolean {
  return split.window.emailed === 0;
}

// ---- S28 FE-4: #13 digest adoption ------------------------------------------------
// The #13 headline: employers who get the digest (on, with an email address).
export function digestHeadline(adoption: DigestAdoption): { value: string; note: string } {
  return {
    value: wholePercent(adoption.digestOnWithEmail, adoption.employers),
    note: `of employers get the digest (${formatCount(adoption.digestOnWithEmail)} of ${formatCount(adoption.employers)})`,
  };
}

// Digest emails sent per week; the week holding `now` is partial.
export function digestSendChart(split: DigestSplit, now: Date = new Date()): { labels: string[]; partialLast: boolean; values: number[] } {
  const last = split.weekly.at(-1);
  return {
    labels: split.weekly.map((w) => weekLabel(w.weekStart)),
    partialLast: last !== undefined && isCurrentWeek(last.weekStart, now),
    values: split.weekly.map((w) => w.sent),
  };
}
