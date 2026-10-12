import { bucketLabel, formatCount, percentOf } from './analytics-format';
import type {
  EmployerHealthFigures,
  EmployerHealthSummary,
  EmployerWeek,
  EmployerWeekly,
  EmployerWeekTableRow,
  FunnelWeeks,
  StaleJob,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

// A week can still change until 14 days after it starts: an application from
// its last day needs 7 more days before it can count as unanswered.
export const SETTLING_DAYS = 14;

// The stale-jobs card lists this many and counts the rest.
export const STALE_JOBS_SHOWN = 25;

// employer_display_name() (migration 031) returns this when there is no company name.
const FALLBACK_EMPLOYER_NAME = 'Empleador';

// Under 48 hours in hours, otherwise in days; one decimal. NULL (nothing to time) is a dash.
export function formatDuration(hours: number | null): string {
  if (hours === null) return '—';
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

// The trend chart's axis is in hours, so its end labels stay in hours too.
export function formatHours(hours: number | null): string {
  return hours === null ? '—' : `${hours.toFixed(1)} h`;
}

// Time to hire comes from SQL in days and is always shown in days.
export function formatDays(days: number | null): string {
  return days === null ? '—' : `${days.toFixed(1)} d`;
}

// "p50 / p75" in one cell. Both percentiles come from the same set, so they are
// NULL together; then the cell is a single dash.
export function formatDurationPair(p50: number | null, p75: number | null): string {
  return p50 === null ? '—' : `${formatDuration(p50)} / ${formatDuration(p75)}`;
}

// Business identity only: the company name, or the fallback plus the first 4
// characters of the employer id so two unnamed employers can be told apart.
export function employerLabel(displayName: string, employerId: string): string {
  return displayName === FALLBACK_EMPLOYER_NAME
    ? `${FALLBACK_EMPLOYER_NAME} · ${employerId.slice(0, 4)}`
    : displayName;
}

const ZERO_FIGURES: EmployerHealthFigures = {
  applications: 0,
  answered: 0,
  answeredUntimed: 0,
  unanswered7d: 0,
  applicationsDue: 0,
  firstResponseP50Hours: null,
  firstResponseP75Hours: null,
  workerTurns: 0,
  turnsUnanswered7d: 0,
  turnsDue: 0,
  replyP50Hours: null,
  replyP75Hours: null,
  hires: 0,
  hiresApproximate: 0,
  timeToHireP50Days: null,
  timeToHireP75Days: null,
};

// The weekly function returns one zero-filled row per week plus one row for the
// whole window (weekStart null). That row is the summary: its percentiles are
// the window's own, never a mean of the weeks. Weeks come back oldest first.
export function splitEmployerWeekly(rows: EmployerWeekly[]): {
  weekly: EmployerWeek[];
  summary: EmployerHealthSummary;
} {
  const weekly: EmployerWeek[] = [];
  let summary: EmployerHealthSummary = { ...ZERO_FIGURES, activeJobs: 0 };
  for (const { weekStart, activeJobs, ...figures } of rows) {
    if (weekStart === null) {
      summary = { ...figures, activeJobs: activeJobs ?? 0 };
    } else {
      weekly.push({ ...figures, weekStart });
    }
  }
  weekly.sort((a, b) => Date.parse(a.weekStart) - Date.parse(b.weekStart));
  return { weekly, summary };
}

export function isWeekSettling(weekStart: string, now: Date = new Date()): boolean {
  return now.getTime() < new Date(weekStart).getTime() + SETTLING_DAYS * DAY_MS;
}

// Weekly table rows, newest first.
export function weeklyTableRows(weekly: EmployerWeek[], now: Date = new Date()): EmployerWeekTableRow[] {
  return [...weekly]
    .sort((a, b) => Date.parse(b.weekStart) - Date.parse(a.weekStart))
    .map((week) => ({
      ...week,
      // bucketLabel's weekly form ("Week of Sep 28") is the '90d' branch.
      label: bucketLabel(week.weekStart, '90d'),
      settling: isWeekSettling(week.weekStart, now),
      approximate: week.hiresApproximate > 0,
    }));
}

// The unanswered shares divide by what is old enough to count: applications
// and worker turns from 7+ days ago (the _due columns), never by all of them.
export function firstResponseNote(figures: EmployerHealthFigures): string {
  return `${percentOf(figures.unanswered7d, figures.applicationsDue) ?? '—'} unanswered after 7 days`;
}

export function replyNote(figures: EmployerHealthFigures): string {
  return `${percentOf(figures.turnsUnanswered7d, figures.turnsDue) ?? '—'} of worker messages unanswered`;
}

// Answered includes answers with no recorded time (dropdown changes before
// Oct 2, approximate hires); the medians do not, so the cell says how many.
export function answeredLabel(figures: EmployerHealthFigures): string {
  const answered = formatCount(figures.answered);
  return figures.answeredUntimed > 0 ? `${answered} · ${formatCount(figures.answeredUntimed)} untimed` : answered;
}

export function hiresNote(figures: EmployerHealthFigures): string {
  const hires = `${formatCount(figures.hires)} ${figures.hires === 1 ? 'hire' : 'hires'}`;
  return figures.hiresApproximate > 0 ? `${hires} · ${formatCount(figures.hiresApproximate)} approximate` : hires;
}

export function staleJobsNote(activeJobs: number): string {
  return `of ${formatCount(activeJobs)} active ${activeJobs === 1 ? 'job' : 'jobs'}`;
}

// The job's idle clock started at posting: no employer action was ever recorded.
export function isIdleSincePosting(job: StaleJob): boolean {
  return job.lastEmployerActionAt === job.postedAt;
}

export function firstWithRest<T>(rows: T[], limit: number): { shown: T[]; more: number } {
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

// Calendar day in UTC, with the year: a stale job can be months old.
export function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// The weeks picker stays on the Employers tab.
export function employersHref(weeks: FunnelWeeks): string {
  return `/analytics/employers?weeks=${weeks}`;
}
