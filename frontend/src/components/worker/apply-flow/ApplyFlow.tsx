'use client';
import { type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import {
  MAX_PROMPT_ANSWER_CHARS,
  missingPromptAnswers,
} from '@/lib/application-requirements-flow';
import type { ApplyFlowAction, ApplyFlowState } from '@/lib/apply-flow-view';
import type { JobDetail } from '@/lib/api/worker';
import { PromptAnswerField } from './PromptAnswerField';

/**
 * STAGE 1: applying, whole and entire, on ONE screen.
 *
 * The three-step wizard is gone. It existed to collect field answers,
 * documents and certification claims at apply time; sprint 23 moved all three
 * behind the employer's "request details" (stage 2,
 * `components/worker/application-requirements/`), which leaves apply with
 * exactly one thing to ask for -- the employer's own `pre_application_prompts`
 * -- and often not even that. So there is no step nav, no review step, and no
 * defaults prefill here: nothing on this screen is worth a second page, and a
 * job that asks nothing renders as a sentence and a button.
 *
 * STILL A CONTROLLED COMPONENT. The `{answers, touched}` reducer lives on the
 * page (`lib/apply-flow-view.ts`), so backing out to the job details and
 * returning does not discard what the worker typed -- the same contract the
 * old flow had, for the same reason.
 *
 * THE SUBMIT GATE IS LOCAL AND EXACT. `missingPromptAnswers` is the same
 * predicate the door enforces (non-blank, <= 1000 chars, every prompt id
 * covered), so a worker is stopped by a disabled button next to the empty box
 * rather than by a 400 after they press it. The two backend codes are still
 * mapped on the page, as the backstop for a job whose prompts changed between
 * load and submit.
 */

/**
 * `submitError` used to be defined in `ReviewStep.tsx`, which no longer
 * exists. The union shrank with the screen: the certification-proof member is
 * unreachable now that claims are collected at stage 2, so what is left is one
 * translated sentence the page has already chosen.
 */
export type ApplyFlowSubmitError = { message: string };

export type ApplyFlowProps = {
  job: JobDetail;
  state: ApplyFlowState;
  dispatch: Dispatch<ApplyFlowAction>;
  onSubmit: () => void;
  submitting: boolean;
  submitError: ApplyFlowSubmitError | null;
  onBackToDetails: () => void;
};

export function ApplyFlow({
  job, state, dispatch, onSubmit, submitting, submitError, onBackToDetails,
}: ApplyFlowProps) {
  const t = useTranslations('worker_job_detail.apply_flow');
  const tCommon = useTranslations('common');

  const prompts = job.pre_application_prompts ?? [];
  const missing = missingPromptAnswers(prompts, state.answers);
  const canSubmit = missing.length === 0;

  return (
    <DashboardPanel>
      <div className="space-y-5 p-5 md:p-6">
        <button
          type="button"
          onClick={onBackToDetails}
          className="inline-block text-left text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
        >
          {t('back_to_details')}
        </button>

        <div>
          {/* 1.4rem/800/-0.03em, per B4.2 -- the same headline weight the
              onboarding steps use for the one question on screen. */}
          <h2 className="text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
            {t('title', { job: job.title })}
          </h2>
          <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
            {prompts.length > 0
              ? t('intro_prompts', { company: job.company_name, count: prompts.length })
              : t('intro_one_tap')}
          </p>
        </div>

        {prompts.length > 0 ? (
          <div className="grid gap-5">
            {prompts.map((prompt) => {
              const value = state.answers[prompt.id] ?? '';
              return (
                <PromptAnswerField
                  key={prompt.id}
                  question={prompt.text}
                  value={value}
                  touched={state.touched.has(prompt.id)}
                  disabled={submitting}
                  onChange={(text) => dispatch({ type: 'set_prompt_answer', promptId: prompt.id, text })}
                  labels={{
                    placeholder: t('placeholder'),
                    chars: t('chars', { count: value.trim().length, max: MAX_PROMPT_ANSWER_CHARS }),
                    tooLong: t('too_long', { max: MAX_PROMPT_ANSWER_CHARS }),
                    blankHint: t('blank_hint'),
                  }}
                />
              );
            })}
          </div>
        ) : null}

        <InlineFeedback tone="info">{t('later_note')}</InlineFeedback>

        {submitError ? (
          <InlineFeedback tone="danger">{submitError.message}</InlineFeedback>
        ) : null}

        <Button
          className="w-full"
          size="lg"
          disabled={!canSubmit}
          loading={submitting}
          loadingLabel={tCommon('loading')}
          onClick={onSubmit}
        >
          {t('submit')}
        </Button>
      </div>
    </DashboardPanel>
  );
}
