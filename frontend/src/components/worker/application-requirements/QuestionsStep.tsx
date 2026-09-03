'use client';
import { useId, useState, type Dispatch } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { FieldEditAction, RequirementsFlowState } from '@/lib/application-requirements-flow';
import { missingRequiredFields, visibleFieldKeys, type AnswerDraft } from '@/lib/application-answers-form';
import type { JobFieldKey } from '@/lib/api/worker';
import { QuestionFieldRow } from './FieldControls';

/**
 * Step 1 of the STAGE-2 details flow: the job's checked custom-field questions
 * (`required_fields`/`optional_fields`), rendered through the
 * `QuestionFieldRow` controls in `FieldControls.tsx`.
 *
 * These questions used to be asked at apply time. Sprint 23 moved them behind
 * the employer's "request details", so the fields now arrive as plain arrays
 * off the stage-2 state document rather than off a `JobDetail`, and Continue
 * is `onContinue` rather than a dispatched `next`: the flow SAVES on the way
 * past, and a step that could advance itself would skip that.
 *
 * Fully controlled: every keystroke dispatches `update_field`/`toggle_skip`
 * straight to the parent-owned `RequirementsFlowState` reducer -- this
 * component holds no draft of its own. The one piece of local state (`attempted`) is a
 * transient "did the worker just try to continue" UI flag, not flow data; it
 * is set on a blocked Continue click and STAYS true across further edits
 * (never reset by `update`/`onSkip`) so that fixing one of several missing
 * fields does not hide the still-missing others' markers -- each row's own
 * marker is keyed on live `missing.includes(key)`, so it clears individually
 * the instant that field becomes complete.
 */
export function QuestionsStep({
  requiredFields, optionalFields, state, dispatch, onContinue, saving, invalidFields,
}: {
  requiredFields: readonly JobFieldKey[];
  optionalFields: readonly JobFieldKey[];
  state: RequirementsFlowState;
  dispatch: Dispatch<FieldEditAction>;
  onContinue: () => void;
  saving: boolean;
  /** Per-key reasons from the door's 400 `invalid_answers`. */
  invalidFields: Record<string, string>;
}) {
  const tFlow = useTranslations('worker_application_details');
  const fieldId = useId();
  const [attempted, setAttempted] = useState(false);

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
    onContinue();
  }

  return (
    <div className="grid gap-5">
      <p className="text-sm text-[var(--jale-ink-2)]">{tFlow('hints.details')}</p>

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
            // A key the DOOR rejected is marked whether or not the worker has
            // tried to continue: the server has already spoken about it.
            missing={(attempted && missing.includes(key)) || key in invalidFields}
            prefilled={state.prefilledKeys.has(key)}
          />
        ))
      )}

      {attempted && missing.length > 0 ? (
        <InlineFeedback tone="warning">
          {tFlow('errors.required_questions', { count: missing.length })}
        </InlineFeedback>
      ) : null}

      {Object.keys(invalidFields).length > 0 ? (
        <InlineFeedback tone="danger">{tFlow('errors.invalid_batch')}</InlineFeedback>
      ) : null}

      <Button className="w-full" size="lg" loading={saving} onClick={handleContinue}>
        {tFlow('continue_button')}
      </Button>
    </div>
  );
}
