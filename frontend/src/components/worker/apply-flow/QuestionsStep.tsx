'use client';
import { useId, useState, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { ApplyFlowAction, ApplyFlowState } from '@/lib/apply-flow-view';
import { missingRequiredFields, visibleFieldKeys, type AnswerDraft } from '@/lib/application-answers-form';
import type { JobDetail } from '@/lib/api/worker';
import { QuestionFieldRow } from './FieldControls';

/**
 * Step 1 of the in-page apply flow: the job's checked custom-field questions
 * (`job.required_fields`/`optional_fields`), rendered through the copied
 * `QuestionFieldRow` controls from `FieldControls.tsx`.
 *
 * Fully controlled: every keystroke dispatches `update_field`/`toggle_skip`
 * straight to the parent-owned `ApplyFlowState` reducer -- this component
 * holds no draft of its own. The one piece of local state (`attempted`) is a
 * transient "did the worker just try to continue" UI flag, not flow data; it
 * is set on a blocked Continue click and STAYS true across further edits
 * (never reset by `update`/`onSkip`) so that fixing one of several missing
 * fields does not hide the still-missing others' markers -- each row's own
 * marker is keyed on live `missing.includes(key)`, so it clears individually
 * the instant that field becomes complete.
 */
export function QuestionsStep({
  job, state, dispatch,
}: {
  job: JobDetail;
  state: ApplyFlowState;
  dispatch: Dispatch<ApplyFlowAction>;
}) {
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const fieldId = useId();
  const [attempted, setAttempted] = useState(false);

  const requiredFields = job.required_fields ?? [];
  const optionalFields = job.optional_fields ?? [];
  const fieldsToShow = visibleFieldKeys(requiredFields, optionalFields);
  const missing = missingRequiredFields(requiredFields, state.draft);

  // `attempted` is deliberately NOT reset here on every keystroke/skip: each
  // row's own red note is already keyed on live `missing.includes(key)`, so
  // it clears the instant that ONE field becomes complete. Resetting
  // `attempted` to false on every edit would hide every OTHER still-missing
  // field's marker the moment the worker fixes just one of several -- the
  // copied `ApplicationAnswersForm` kept its equivalent `showMissing` flag
  // sticky for exactly this reason.
  function update<K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) {
    dispatch({ type: 'update_field', key, value });
  }

  function onSkip(key: string) {
    dispatch({ type: 'toggle_skip', key });
  }

  function handleContinue() {
    if (missing.length > 0) {
      setAttempted(true);
      return;
    }
    dispatch({ type: 'next' });
  }

  return (
    <div className="grid gap-5">
      <p className="text-sm text-[var(--jale-ink-2)]">{tFlow('hints.questions')}</p>

      {fieldsToShow.length === 0 ? null : (
        // A job that checked no custom fields at all still routes through
        // this step (Wave-3 decides whether to skip it up front); rendering
        // no rows -- just the hint above and the Continue button below --
        // keeps that decision cheap either way.
        fieldsToShow.map((key) => (
          <QuestionFieldRow
            key={key}
            fieldKey={key}
            required={requiredFields.includes(key)}
            skipped={state.skipped.has(key)}
            onSkip={() => onSkip(key)}
            draft={state.draft}
            update={update}
            fieldId={fieldId}
            missing={attempted && missing.includes(key)}
            prefilled={state.prefilledKeys.has(key)}
          />
        ))
      )}

      {attempted && missing.length > 0 ? (
        <InlineFeedback tone="warning">
          {tFlow('errors.required_questions', { count: missing.length })}
        </InlineFeedback>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={handleContinue}>{tFlow('continue_button')}</Button>
      </div>
    </div>
  );
}
