import { percentOf } from './analytics-format';
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

function stepOrder(stepKey: string): number {
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

// Cell wash for a cohort-table share: a stronger blue for a higher share.
export function shareShade(part: number, whole: number): string | undefined {
  if (whole <= 0) return undefined;
  const alpha = 0.06 + 0.3 * Math.min(1, Math.max(0, part / whole));
  return `rgba(1, 121, 255, ${alpha.toFixed(2)})`;
}

// The weeks and door links preserve each other; the default door is left out.
export function funnelsHref(weeks: FunnelWeeks, door: FunnelDoor): string {
  return door === 'all' ? `/analytics/funnels?weeks=${weeks}` : `/analytics/funnels?weeks=${weeks}&door=${door}`;
}
