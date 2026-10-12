import { formatCount } from './analytics-format';
import { cohortWeekStarts, stepLabel, stepOrder } from './funnel';
import { newestWeeksFirst, wholePercent } from './ops-health';
import type { FunnelDoor, FunnelWeeks, OnboardingRestart, OperatorReset } from './types';

// Code-point order, so a sort never depends on locale collation.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- Start over and back by step ----------------------------------------------
// Start over is a WhatsApp command; the web form has none, so the web door
// shows a dash and counts back presses only.
export function hasStartOver(door: FunnelDoor): boolean {
  return door !== 'web';
}

// "12 · 8%": workers, then their share of the workers who were at the step
// ('—' when nobody was). Start over is '—' on the web. Presses are start-over
// and back presses (back presses only on the web).
export type RestartCells = {
  reached: number;
  startedOver: string;
  wentBack: string;
  presses: number;
};

export type RestartStepRow = RestartCells & { stepKey: string; label: string };

function workersCell(workers: number, reached: number): string {
  return `${formatCount(workers)} · ${wholePercent(workers, reached)}`;
}

function restartCells(row: OnboardingRestart | undefined, door: FunnelDoor): RestartCells {
  const startOver = hasStartOver(door);
  if (!row) {
    return { reached: 0, startedOver: startOver ? workersCell(0, 0) : '—', wentBack: workersCell(0, 0), presses: 0 };
  }
  return {
    reached: row.reached,
    startedOver: startOver ? workersCell(row.restartWorkers, row.reached) : '—',
    wentBack: workersCell(row.backWorkers, row.reached),
    presses: (startOver ? row.restartPresses : 0) + row.backPresses,
  };
}

function hasStep(row: OnboardingRestart): row is OnboardingRestart & { stepKey: string } {
  return row.stepKey !== null;
}

// The door's whole-window step rows (weekStart null, a step key), in
// onboarding order. SQL returns a step only when something happened there and
// computes 'all' itself, distinct across doors, so nothing is re-summed here.
export function restartStepRows(rows: OnboardingRestart[], door: FunnelDoor): RestartStepRow[] {
  return rows
    .filter(hasStep)
    .filter((row) => row.weekStart === null && row.door === door)
    .sort((a, b) => stepOrder(a.stepKey) - stepOrder(b.stepKey) || byText(a.stepKey, b.stepKey))
    .map((row) => ({ stepKey: row.stepKey, label: stepLabel(row.stepKey), ...restartCells(row, door) }));
}

// The total row: the door's whole-window all-steps row (stepKey null), whose
// workers are distinct across steps, so it is never a sum of the step rows.
// A missing row reads as zeros.
export function restartTotals(rows: OnboardingRestart[], door: FunnelDoor): RestartCells {
  return restartCells(
    rows.find((row) => row.weekStart === null && row.door === door && row.stepKey === null),
    door,
  );
}

// Nobody started over or went back in these weeks (on this door): the
// section shows its empty state instead of a table and a flat chart.
export function restartsEmpty(rows: OnboardingRestart[], door: FunnelDoor): boolean {
  return restartStepRows(rows, door).every((row) => row.presses === 0);
}

export type RestartWeek = { weekStart: string; restartWorkers: number; backWorkers: number };

// One entry per week of the window, oldest first, on the console clock like
// the cohort table: the door's all-steps row for that week (workers distinct
// across steps). SQL returns a row only when something happened, so a week
// without one had nobody: 0, not a gap. Start over is always 0 on the web.
export function restartWeeks(
  rows: OnboardingRestart[],
  door: FunnelDoor,
  weeks: FunnelWeeks,
  now: Date = new Date(),
): RestartWeek[] {
  const startOver = hasStartOver(door);
  return cohortWeekStarts(weeks, now).map((weekStart) => {
    const row = rows.find((entry) => entry.weekStart === weekStart && entry.door === door && entry.stepKey === null);
    return {
      weekStart,
      restartWorkers: startOver && row ? row.restartWorkers : 0,
      backWorkers: row ? row.backWorkers : 0,
    };
  });
}

// ---- Operator resets -----------------------------------------------------------
export type ResetTableRow = OperatorReset & { label: string; current: boolean };

// The counted resets (bulk runs left out): newest week first, then the most
// resets, then the reason. Operator resets have no door.
export function resetTableRows(rows: OperatorReset[], now: Date = new Date()): ResetTableRow[] {
  return newestWeeksFirst(
    rows.filter((row) => !row.bulk).sort((a, b) => b.resets - a.resets || byText(a.reason, b.reason)),
    now,
  );
}

// "Jul 29" in UTC; the year is added when it is not the current UTC year.
function shortDay(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

// The bulk runs left out of the counts, oldest first, or null when there are
// none: "Left out: 1 bulk run ('<reason>', 412 workers, Jul 29)."
export function bulkRunsNote(rows: OperatorReset[], now: Date = new Date()): string | null {
  const runs = rows
    .filter((row) => row.bulk)
    .map((row) => ({ ...row, at: row.runStartedAt ?? row.weekStart }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (runs.length === 0) return null;
  const listed = runs
    .map((run) => `'${run.reason}', ${formatCount(run.workers)} ${run.workers === 1 ? 'worker' : 'workers'}, ${shortDay(run.at, now)}`)
    .join('; ');
  return `Left out: ${formatCount(runs.length)} bulk ${runs.length === 1 ? 'run' : 'runs'} (${listed}).`;
}
