import type { ChartColor, ChartSeries } from '../components/analytics/charts/types';
import {
  ANALYTICS_RELEASE_LABEL,
  formatCount,
  oldestFirst,
  percentOf,
  shareRate,
  weekLabel,
  weeklyAxis,
  wholePercent,
} from './analytics-format';
import type {
  AcquisitionSource,
  AcquisitionWeek,
  IdentityFunnel,
  JobViewWeek,
  MatchWeek,
  OnboardingStepRow,
  ReferralWeek,
} from './server/admin-analytics';
import type {
  CohortCounts,
  FunnelDoor,
  FunnelStage,
  FunnelStageKey,
  FunnelWeeks,
  OnboardingCohort,
  OnboardingStalled,
  StalledStep,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

type Counts = Omit<CohortCounts, 'cohortWeek'>;

const ZERO: Counts = {
  started: 0,
  codeRequested: 0,
  verified: 0,
  acceptedTerms: 0,
  finishedProfile: 0,
  ready: 0,
  declined: 0,
  inProgress: 0,
  abandoned: 0,
};
const COUNT_KEYS = Object.keys(ZERO) as (keyof Counts)[];

// Monday 00:00 UTC, matching Postgres date_trunc('week', ts, 'UTC').
function isoWeekStart(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}

// The current week and the weeks - 1 before it, oldest first.
export function cohortWeekStarts(weeks: FunnelWeeks, now: Date = new Date()): string[] {
  const current = isoWeekStart(now).getTime();
  return Array.from({ length: weeks }, (_, i) => new Date(current - (weeks - 1 - i) * WEEK_MS).toISOString());
}

// One row per week (oldest first) for the selected door; 'all' adds both
// doors. Weeks with no starters are zero-filled so the table has no gaps.
export function cohortsForDoor(rows: OnboardingCohort[], door: FunnelDoor, weekStarts: string[]): CohortCounts[] {
  return weekStarts.map((cohortWeek) => {
    const counts: CohortCounts = { cohortWeek, ...ZERO };
    for (const row of rows) {
      if (row.cohortWeek !== cohortWeek || (door !== 'all' && row.door !== door)) continue;
      for (const key of COUNT_KEYS) counts[key] += row[key];
    }
    return counts;
  });
}

export function totalCounts(weeks: CohortCounts[]): Counts {
  const total: Counts = { ...ZERO };
  for (const week of weeks) {
    for (const key of COUNT_KEYS) total[key] += week[key];
  }
  return total;
}

const STAGES: { key: FunnelStageKey; label: string }[] = [
  { key: 'started', label: 'Started' },
  { key: 'codeRequested', label: 'Requested a code' },
  { key: 'verified', label: 'Verified' },
  { key: 'acceptedTerms', label: 'Accepted terms' },
  { key: 'finishedProfile', label: 'Finished profile' },
  { key: 'ready', label: 'Ready' },
];

// "Requested a code" only means something on WhatsApp: the web door sends the
// code at sign-up, so for web (and the combined view) it would equal Started.
export function funnelStages(total: Counts, door: FunnelDoor): FunnelStage[] {
  const shown = STAGES.filter((stage) => stage.key !== 'codeRequested' || door === 'whatsapp');
  return shown.map((stage, i) => ({
    key: stage.key,
    label: stage.label,
    count: total[stage.key],
    ofStarted: i === 0 ? null : percentOf(total[stage.key], total.started),
    ofPrevious: i === 0 ? null : percentOf(total[stage.key], total[shown[i - 1].key]),
  }));
}

// A cohort can still move until 7 days after its week ends.
export function isSettling(cohortWeek: string, now: Date = new Date()): boolean {
  return now.getTime() < new Date(cohortWeek).getTime() + 2 * WEEK_MS;
}

const STEP_ORDER = [
  'start.choose_language',
  'identity.verify_otp',
  'legal.review',
  'profile.voice_choice',
  'profile.voice_processing',
  'profile.name',
  'profile.location',
  'profile.trade',
  'profile.custom_trade',
  'profile.experience',
  'profile.transportation',
  'profile.availability',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
  'profile.photo',
  'profile.photo_type',
];

const STEP_LABELS: Record<string, string> = {
  'start.choose_language': 'Language',
  'identity.verify_otp': 'Phone code',
  'legal.review': 'Terms',
  'profile.voice_choice': 'Voice note',
  'profile.voice_processing': 'Voice note processing',
  'profile.name': 'Name',
  'profile.location': 'Location',
  'profile.trade': 'Trade',
  'profile.custom_trade': 'Custom trade',
  'profile.experience': 'Experience',
  'profile.transportation': 'Transportation',
  'profile.availability': 'Availability',
  'trust.question.1': 'Trust question 1',
  'trust.question.2': 'Trust question 2',
  'trust.question.3': 'Trust question 3',
  'profile.photo': 'Photo',
  'profile.photo_type': 'Photo type',
};

export function stepLabel(stepKey: string): string {
  return STEP_LABELS[stepKey] ?? stepKey;
}

// The step's place in onboarding (113's order); unknown keys sort after every known one.
export function stepOrder(stepKey: string): number {
  const index = STEP_ORDER.indexOf(stepKey);
  return index === -1 ? STEP_ORDER.length : index;
}

// Stuck workers by step for the selected door, most first; ties keep the
// onboarding order. 'all' includes runs whose door is unknown ('other').
export function stalledForDoor(rows: OnboardingStalled[], door: FunnelDoor): StalledStep[] {
  const byStep = new Map<string, number>();
  for (const row of rows) {
    if (door !== 'all' && row.door !== door) continue;
    byStep.set(row.stepKey, (byStep.get(row.stepKey) ?? 0) + row.workers);
  }
  return [...byStep]
    .map(([stepKey, workers]) => ({ stepKey, label: stepLabel(stepKey), workers }))
    .sort((a, b) => b.workers - a.workers || stepOrder(a.stepKey) - stepOrder(b.stepKey));
}

// Cell wash for a cohort-table share: more of the first chart colour for a
// higher share (6% to 36% of it), in both themes.
export function shareShade(part: number, whole: number): string | undefined {
  if (whole <= 0) return undefined;
  const mix = Math.round((0.06 + 0.3 * Math.min(1, Math.max(0, part / whole))) * 100);
  return `color-mix(in srgb, var(--chart-1) ${mix}%, transparent)`;
}

// The weeks and door links preserve each other; the default door is left out.
export function funnelsHref(weeks: FunnelWeeks, door: FunnelDoor): string {
  return door === 'all' ? `/analytics/funnels?weeks=${weeks}` : `/analytics/funnels?weeks=${weeks}&door=${door}`;
}

// ---- S28 FE-4: the Funnels tab and #16 (K3.3 shapes) ----------------------------
// A funnel stage as FunnelChart takes it; `branch` marks a step only some
// workers take (it is never counted as a drop).
export type FunnelStageView = { key: string; label: string; count: number; branch?: boolean };

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// #14: the starters, then every step in onboarding order (share of the starters).
export function onboardingStepStages(result: { started: number; steps: OnboardingStepRow[] }): FunnelStageView[] {
  const steps = [...result.steps].sort((a, b) => a.order - b.order || byKey(a.stepKey, b.stepKey));
  return [
    { key: 'started', label: 'Started', count: result.started },
    ...steps.map((step) => ({
      key: step.stepKey,
      label: step.branch ? `${step.label} (some workers only)` : step.label,
      count: step.reached,
      branch: step.branch,
    })),
  ];
}

// "1,000 workers started in the range. Biggest drop: Phone code (−24 points)."
// Points are shares of the starters, between neighbouring steps that every
// worker takes; a branch step is skipped, never read as a drop.
export function onboardingCaption(stages: FunnelStageView[]): string {
  const started = stages[0]?.count ?? 0;
  const head = `${formatCount(started)} ${started === 1 ? 'worker' : 'workers'} started in the range.`;
  if (started <= 0) return head;
  const main = stages.filter((stage) => !stage.branch);
  let worst: { label: string; points: number } | null = null;
  for (let i = 1; i < main.length; i += 1) {
    const points = Math.round(((main[i - 1].count - main[i].count) * 100) / started);
    if (points > 0 && (worst === null || points > worst.points)) worst = { label: main[i].label, points };
  }
  return worst === null ? head : `${head} Biggest drop: ${worst.label} (−${worst.points} points).`;
}

// #15 (WhatsApp door only).
export function identityStages(f: IdentityFunnel): FunnelStageView[] {
  return [
    { key: 'challenges', label: 'Started verification', count: f.challenges },
    { key: 'reachedCode', label: 'Reached the code step', count: f.reachedCode },
    { key: 'verified', label: 'Verified', count: f.verified },
  ];
}

export const ATTEMPT_LABELS = ['No attempts', '1 attempt', '2 attempts', '3 or more'];

export function identityAttemptValues(f: IdentityFunnel): number[] {
  return [f.attempts.zero, f.attempts.one, f.attempts.two, f.attempts.threePlus];
}

// Each outcome with its share of the challenges.
export function identityOutcomes(f: IdentityFunnel): { label: string; value: string }[] {
  return [
    { label: 'Locked at least once', value: `${formatCount(f.lockedOnce)} · ${wholePercent(f.lockedOnce, f.challenges)}` },
    { label: 'Expired unused', value: `${formatCount(f.expiredUnused)} · ${wholePercent(f.expiredUnused, f.challenges)}` },
  ];
}

const minutesText = (m: number): string => (m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

// "Median 4 min to verify · 75% within 9 min · timings since Oct 5"
export function identityTimingText(f: IdentityFunnel): string {
  if (f.medianMinutesToVerify === null) return 'No verification timings in these weeks.';
  const p75 = f.p75MinutesToVerify === null ? '' : ` · 75% within ${minutesText(f.p75MinutesToVerify)}`;
  const since = f.timingsSince === null ? '' : ` · timings since ${weekLabel(f.timingsSince)}`;
  return `Median ${minutesText(f.medianMinutesToVerify)} to verify${p75}${since}`;
}

// #12: the cohort funnel of the WhatsApp door, whatever door the page shows.
export function whatsappStages(rows: OnboardingCohort[], weeks: FunnelWeeks, now: Date = new Date()): FunnelStageView[] {
  return funnelStages(totalCounts(cohortsForDoor(rows, 'whatsapp', cohortWeekStarts(weeks, now))), 'whatsapp').map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: stage.count,
  }));
}

// #21: the window's totals, link opened first.
export function referralStages(weeks: ReferralWeek[]): FunnelStageView[] {
  const total = (pick: (week: ReferralWeek) => number): number => weeks.reduce((sum, week) => sum + pick(week), 0);
  return [
    { key: 'opens', label: 'Link opened', count: total((w) => w.opens) },
    { key: 'applyIntents', label: 'Tapped apply', count: total((w) => w.applyIntents) },
    { key: 'claims', label: 'Signed up', count: total((w) => w.claims) },
    { key: 'applications', label: 'Applied', count: total((w) => w.applications) },
    { key: 'hires', label: 'Hired', count: total((w) => w.hires) },
  ];
}

export function referralNote(snapshotsSince: string | null): string {
  const since = snapshotsSince === null ? `Snapshots start with ${ANALYTICS_RELEASE_LABEL}.` : `Snapshots since ${weekLabel(snapshotsSince)}.`;
  return `Kept as daily snapshots, so history survives link expiry. ${since}`;
}

export type WeeklyChart = { labels: string[]; partialLast: boolean; series: ChartSeries[]; empty: boolean };

// #17: the share of views that became applications, per week: the public job
// page (history exists) and signed-in workers (collected from this release).
export function jobViewChart(result: { weeks: JobViewWeek[]; collectingSince: string | null }): WeeklyChart {
  const weeks = oldestFirst(result.weeks);
  const publicRates = weeks.map((w) => shareRate(w.publicApplications, w.publicOpens));
  const signedIn = weeks.map((w) => (result.collectingSince === null ? null : shareRate(w.workerViewApplications, w.workerViews)));
  return {
    ...weeklyAxis(weeks),
    series: [
      { key: 'public', label: 'Public job page', color: 'chart-1', values: publicRates },
      { key: 'signedIn', label: 'Signed-in workers', color: 'chart-2', values: signedIn },
    ],
    empty: [...publicRates, ...signedIn].every((v) => v === null),
  };
}

// #20: per channel, the share of matches shown that led to an application
// within 7 days.
export function matchChart(result: { weeks: MatchWeek[]; collectingSince: string | null }): WeeklyChart {
  const starts = [...new Set(result.weeks.map((w) => w.weekStart))].sort((a, b) => Date.parse(a) - Date.parse(b));
  const partial = new Set(result.weeks.filter((w) => w.partial).map((w) => w.weekStart));
  const rate = (channel: MatchWeek['channel'], weekStart: string): number | null => {
    const row = result.weeks.find((w) => w.weekStart === weekStart && w.channel === channel);
    return row === undefined ? null : shareRate(row.appliedWithin7d, row.shown);
  };
  return {
    labels: starts.map(weekLabel),
    partialLast: starts.length > 0 && partial.has(starts[starts.length - 1]),
    series: [
      { key: 'web', label: 'Web job feed', color: 'chart-1', values: starts.map((s) => rate('web', s)) },
      { key: 'whatsapp', label: 'WhatsApp', color: 'chart-2', values: starts.map((s) => rate('whatsapp', s)) },
    ],
    empty: result.collectingSince === null,
  };
}

// #16: one row per source, in this fixed order and colour (a source keeps its
// colour whatever the data).
export const ACQUISITION_SOURCES: readonly { source: AcquisitionSource; label: string; color: ChartColor }[] = [
  { source: 'shared_link', label: 'Shared links', color: 'chart-1' },
  { source: 'campaign_tag', label: 'Campaign tags', color: 'chart-2' },
  { source: 'referral', label: 'Referrals', color: 'chart-3' },
  { source: 'direct', label: 'Direct', color: 'chart-4' },
  { source: 'whatsapp_entry', label: 'WhatsApp entry', color: 'chart-5' },
  { source: 'unknown', label: 'Unknown', color: 'chart-6' },
];

export function acquisitionChart(result: { weeks: AcquisitionWeek[]; collectingSince: string | null }): WeeklyChart {
  const weeks = oldestFirst(result.weeks);
  return {
    ...weeklyAxis(weeks),
    series: ACQUISITION_SOURCES.map(({ source, label, color }) => ({
      key: source,
      label,
      color,
      values: weeks.map((w) => w.bySource[source]),
    })),
    empty: result.collectingSince === null,
  };
}
