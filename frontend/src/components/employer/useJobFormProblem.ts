'use client';
import { useCallback, useEffect, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import type { JobFormFieldProblem } from '@/lib/job-form';
import { MAX_PROMPT_CHARS } from '@/lib/pre-application-prompts';

/**
 * The sentence for a refused job-form step (sprint 29). It names the field
 * ("Add a job title"), so the employer is not left hunting for which one;
 * codes whose existing sentence already names its field keep that sentence.
 */
export function useJobFormProblemMessage(): (problem: JobFormFieldProblem) => string {
  const t = useTranslations('employer_dashboard');
  const tReq = useTranslations('job_requirements');

  return useCallback(
    (problem: JobFormFieldProblem): string => {
      switch (problem.code) {
        case 'location_pick_required':
          return t('modal.location_pick_required');
        case 'state_region':
          return t('modal.validation_state_region');
        case 'pay_range':
          return t('modal.validation_pay_range');
        case 'prompt_blank':
          return tReq('prompts.validation_blank');
        case 'prompt_too_long':
          return tReq('prompts.validation_too_long', { max: MAX_PROMPT_CHARS });
        default:
          break;
      }
      switch (problem.field) {
        case 'title': return t('modal.field_errors.title');
        case 'location': return t('modal.field_errors.location');
        case 'trade_category': return t('modal.field_errors.trade');
        case 'trade_category_other': return t('modal.field_errors.trade_other');
        case 'pay_min': return t('modal.field_errors.pay_min');
        case 'pay_max': return t('modal.field_errors.pay_max');
        case 'required_experience_years': return t('modal.field_errors.experience');
        case 'number_of_workers_needed': return t('modal.field_errors.workers');
        case 'shift_start': return t('modal.field_errors.shift_start');
        case 'shift_end': return t('modal.field_errors.shift_end');
        case 'shift_periods': return t('modal.field_errors.shift_periods');
        default: return t('modal.validation_required');
      }
    },
    [t, tReq],
  );
}

/**
 * Moves focus to the field a refused step is about, found by its
 * `data-field` inside `formRef` (a question is `prompt-<n>`), scrolling it to
 * the middle of the view. `request` counts refusals, so the same field
 * refused twice is focused twice.
 *
 * Call it AFTER any effect that focuses a step heading: effects run in
 * declaration order, so when a refusal also changes the step the field wins.
 */
export function useFocusJobFormProblem(
  formRef: RefObject<HTMLFormElement | null>,
  problem: JobFormFieldProblem | null,
  request: number,
): void {
  useEffect(() => {
    if (request === 0 || !problem) return;
    const key = problem.field === 'prompt' ? `prompt-${problem.index ?? 0}` : problem.field;
    const host = formRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`);
    const target = host?.matches('input, select, textarea, button')
      ? host
      : host?.querySelector<HTMLElement>('input, select, textarea, button');
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus();
  }, [formRef, problem, request]);
}
