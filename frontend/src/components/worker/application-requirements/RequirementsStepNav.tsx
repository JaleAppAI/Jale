'use client';
import { useTranslations } from 'next-intl';
import { REQUIREMENT_STEP_IDS } from '@/lib/application-requirements-flow';

/**
 * The 3-step chip row for the stage-2 details flow (formerly `ApplyStepNav`).
 *
 * NOT a rename. The old nav gated forward jumps on `maxVisitedIndex` -- "have
 * you been here before" -- and the stage-2 reducer has no such field, by
 * design: this door is a second window onto a server-side engine, and where a
 * worker has clicked in THIS tab says nothing about what the application still
 * owes. Reachability is therefore computed from live validity instead
 * (`canLeaveDetails`/`canLeaveDocuments`, derived by the flow from the draft
 * and the server's `remaining`), which is also what the prototype shows:
 * steps 2 and 3 sit disabled until the ones before them are satisfied.
 *
 * Backward moves are always free. Every chip is a REAL `<button>` -- a
 * genuinely unreachable one is `disabled` rather than an inert `<span>`, so it
 * is still identifiable as a control to a screen reader.
 */
export function RequirementsStepNav({
  stepIndex, onGoto, canLeaveDetails, canLeaveDocuments,
}: {
  stepIndex: number;
  onGoto: (index: number) => void;
  canLeaveDetails: boolean;
  canLeaveDocuments: boolean;
}) {
  const t = useTranslations('worker_application_details.steps');

  // `priorStepsValid[n]` = AND of every step strictly before index `n`.
  const priorStepsValid = [true, canLeaveDetails, canLeaveDetails && canLeaveDocuments];

  return (
    <nav aria-label={t('aria_label')}>
      <p className="sr-only">
        {t('step_label', { current: stepIndex + 1, total: REQUIREMENT_STEP_IDS.length })}
      </p>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {REQUIREMENT_STEP_IDS.map((id, index) => {
          const current = index === stepIndex;
          const done = index < stepIndex;
          const reachable = index <= stepIndex || priorStepsValid[index];

          return (
            <li key={id} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                disabled={!reachable}
                onClick={() => onGoto(index)}
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
                <span className="truncate">{t(id)}</span>
                {done ? <span className="sr-only"> — {t('completed')}</span> : null}
              </button>

              {index < REQUIREMENT_STEP_IDS.length - 1 ? (
                <span aria-hidden className="h-px w-4 shrink-0 bg-[var(--jale-divider)]" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
