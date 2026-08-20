'use client';
import type { Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { APPLY_STEP_IDS, canJumpToStep, type ApplyFlowAction, type ApplyFlowState } from '@/lib/apply-flow-view';

/**
 * The 3-step chip row for the in-page apply flow, styled after
 * `PostJobModal`'s step indicator (`aria-current="step"` on the live step,
 * a small dot per chip, an `<ol>`/`<nav aria-label>` shell, a `sr-only`
 * "Step X of Y" line) with ONE deliberate a11y departure: PostJobModal
 * renders a completed step as a `<button>` but every other step as a plain
 * `<span>` (its forward jumps are always closed, so there is nothing for a
 * non-done chip to do). This flow's reducer allows forward jumps too
 * (`canJumpToStep`, already-visited steps), so every chip here is a REAL
 * `<button>` -- never a `<div>`/`<span>` standing in for one -- and a
 * genuinely unreachable forward chip is a `disabled` button (still
 * focus-skippable, still identifiable as a button to a screen reader) rather
 * than an inert span.
 *
 * Backward jumps (`n <= state.stepIndex`) are always free, per the task
 * spec. Forward jumps need BOTH `canJumpToStep` (has this step already been
 * visited -- `maxVisitedIndex`) AND that every step strictly before the
 * target is CURRENTLY valid (`canAdvanceFromQuestions`/`canAdvanceFromDocuments`,
 * computed fresh from live state by `ApplyFlow`, not cached at visit time).
 * `canJumpToStep` alone is necessary but not sufficient: a worker who
 * reaches Review, backs up to Questions, and clears a required answer must
 * not be able to jump back to Review via the chip while that answer is
 * empty, even though `maxVisitedIndex` still remembers Review was visited.
 */
export function ApplyStepNav({
  state, dispatch, canAdvanceFromQuestions, canAdvanceFromDocuments,
}: {
  state: ApplyFlowState;
  dispatch: Dispatch<ApplyFlowAction>;
  canAdvanceFromQuestions: boolean;
  canAdvanceFromDocuments: boolean;
}) {
  const t = useTranslations('worker_job_detail.apply_flow');

  // `priorStepsValid[n]` = AND of every step strictly before index `n`'s own
  // validity. Index 0 (questions) has no prior step, so it is trivially
  // reachable from behind; index 1 (documents) needs questions valid; index 2
  // (review) needs both.
  const priorStepsValid = [true, canAdvanceFromQuestions, canAdvanceFromQuestions && canAdvanceFromDocuments];

  return (
    <nav aria-label={t('steps.aria_label')} className="mb-5">
      <p className="sr-only">
        {t('steps.step_label', { current: state.stepIndex + 1, total: APPLY_STEP_IDS.length })}
      </p>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {APPLY_STEP_IDS.map((id, index) => {
          const label = t(`steps.${id}`);
          const current = index === state.stepIndex;
          const done = index < state.stepIndex;
          const reachable = index <= state.stepIndex || (canJumpToStep(index, state.maxVisitedIndex) && priorStepsValid[index]);

          return (
            <li key={id} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                disabled={!reachable}
                onClick={() => dispatch({ type: 'goto', index })}
                className={[
                  'inline-flex min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  current
                    ? 'font-extrabold text-[var(--jale-ink)]'
                    : reachable
                      ? 'font-semibold text-[var(--jale-ink)] hover:underline'
                      : 'font-semibold text-[var(--jale-ink-2)] cursor-not-allowed opacity-60',
                ].join(' ')}
              >
                <span
                  aria-hidden
                  className={[
                    'size-[7px] shrink-0 rounded-full',
                    done ? 'bg-[var(--jale-success)]' : current ? 'bg-[var(--jale-blue-500)]' : 'bg-[var(--jale-divider)]',
                  ].join(' ')}
                />
                <span className="truncate">{label}</span>
                {done ? <span className="sr-only"> — {t('steps.completed')}</span> : null}
              </button>

              {index < APPLY_STEP_IDS.length - 1 ? (
                <span aria-hidden className="h-px w-4 shrink-0 bg-[var(--jale-divider)]" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
