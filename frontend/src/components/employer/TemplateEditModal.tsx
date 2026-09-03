'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, saveJobTemplate, type JobTemplate } from '@/lib/api/employer';
import {
  type JobForm, initialForm, jobFormFromTemplatePayload, jobFormToCreatePayload,
  validateFullJobForm, applyLocationToJobForm,
} from '@/lib/job-form';
import { MAX_PROMPT_CHARS } from '@/lib/pre-application-prompts';
import { planLimitModel, type PlanLimitModel } from '@/lib/plan-limit';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { JobFormFields } from '@/components/employer/JobFormFields';
import { Modal } from '@/components/ui/modal';
import { PlanLimitNotice } from '@/components/employer/PlanLimitDialog';

/**
 * Create or edit a job template: a name plus the full job form (minus the
 * start date -- templates never carry one). Rename and content edits are the
 * same save call; the backend upserts by optional id.
 *
 * Seeds its state in useState initializers, so the CALLER must remount it per
 * open (the templates page keys it on the editing id) -- the same contract the
 * page's other modals follow.
 */
interface Props {
  open: boolean;
  template: JobTemplate | null; // null = new template
  onClose: () => void;
  onSaved: (saved: JobTemplate) => void;
}

export function TemplateEditModal({ open, template, onClose, onSaved }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tReq = useTranslations('job_requirements');
  const { idToken } = useAuth();

  const [name, setName] = useState(template?.name ?? '');
  const [form, setForm] = useState<JobForm>(() =>
    template ? jobFormFromTemplatePayload(template.payload).form : initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  // The template cap is not a "save failed" sentence -- it is a plan decision
  // with its own copy, its own way out, and no dismiss. `lib/plan-limit` owns
  // all three; this modal only decides where the notice sits.
  const [limitModel, setLimitModel] = useState<PlanLimitModel | null>(null);

  // The name is this form's one field the job form does not have; it is also
  // where editing starts, so the Modal lands initial focus on it.
  const nameRef = useRef<HTMLInputElement>(null);

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleClose = () => {
    if (loading) return;
    onClose();
  };

  const handleSubmit = async () => {
    // Clear every outcome of the PREVIOUS attempt up front, so a validation
    // failure after a limit error renders as a plain message instead of
    // inheriting the limit branch's upgrade CTA and tooltip.
    setNameError('');
    setError('');
    setLimitModel(null);
    if (!name.trim()) return setNameError(t('templates.name_required'));
    // `validateFullJobForm` replaces this modal's own inline checks -- no
    // `minWorkers` floor here, unlike EditJobModal: a template has no hired
    // workers to protect. `trade_category_other_required` and
    // `shift_incomplete` both fall back onto `validation_required` per
    // `validateStepBasics`/`validateStepDetails`'s own doc comments -- there
    // is no dedicated key for either yet.
    const code = validateFullJobForm(form);
    switch (code) {
      case null:
        break;
      case 'required':
      case 'trade_category_other_required':
      case 'shift_incomplete':
        return setError(t('modal.validation_required'));
      case 'location_pick_required':
        return setError(t('modal.location_pick_required'));
      case 'state_region':
        return setError(t('modal.validation_state_region'));
      case 'number':
        return setError(t('modal.validation_number'));
      case 'pay_range':
        return setError(t('modal.validation_pay_range'));
      case 'headcount':
        return setError(t('modal.validation_headcount'));
      // The prompts editor's two -- see EditJobModal for why these get their
      // own sentences rather than the generic `validation_required`.
      case 'prompt_blank':
        return setError(tReq('prompts.validation_blank'));
      case 'prompt_too_long':
        return setError(tReq('prompts.validation_too_long', { max: MAX_PROMPT_CHARS }));
    }
    setLoading(true);
    try {
      const saved = await saveJobTemplate(idToken!, {
        ...(template ? { id: template.id } : {}),
        name: name.trim(),
        payload: jobFormToCreatePayload(form),
      });
      onSaved(saved);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'template_name_taken') {
        setNameError(t('modal.template_name_taken'));
      } else if (err instanceof ApiError && err.code === 'template_limit_reached') {
        setLimitModel(planLimitModel(err));
      } else if (err instanceof ApiError && err.code === 'city_required') {
        // Same requirements-picker-adjacent 400 PostJobModal/EditJobModal
        // classify -- a template's payload goes through the identical
        // create-shape validation.
        setError(tReq('errors.city_required'));
      } else if (err instanceof ApiError && err.code === 'requirements_tier_overlap') {
        setError(tReq('errors.tier_overlap'));
      } else if (err instanceof ApiError && err.code === 'invalid_pre_application_prompts') {
        setError(tReq('prompts.invalid_rejected'));
      } else {
        setError(t('templates.save_error'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={template ? t('templates.edit_title') : t('templates.new_title')}
      size="md"
      initialFocusRef={nameRef}
      // A half-typed template must not evaporate on a stray backdrop click.
      closeOnOverlay={false}
      footer={
        <div className="flex w-full flex-col gap-3">
          {error ? (
            <InlineFeedback tone="danger" onDismiss={() => setError('')}>
              <span className="block">{error}</span>
            </InlineFeedback>
          ) : null}
          {/* Not dismissible, as before: the cap is still true after you wave it
              away, and this is the only thing explaining why nothing saved. */}
          <PlanLimitNotice model={limitModel} onNavigate={onClose} />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={loading} className="flex-1">
              {t('modal.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={loading}
              loadingLabel={tCommon('loading')}
              className="flex-1"
            >
              {t('templates.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.name_label')} *</label>
          <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          {nameError && <p className="text-xs font-semibold text-[var(--jale-danger)]">{nameError}</p>}
        </div>

        <JobFormFields
          form={form}
          onUpdate={update}
          onLocationChange={(v) => setForm((c) => applyLocationToJobForm(c, v))}
          showStartDate={false}
        />
      </div>
    </Modal>
  );
}
