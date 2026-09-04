'use client';
import { useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, saveJobTemplate, type JobTemplate } from '@/lib/api/employer';
import {
  type JobForm, initialForm, jobFormFromTemplatePayload, jobFormToCreatePayload,
  validateFullJobForm, validateStepBasics, applyLocationToJobForm,
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
  // Seeded once (this modal is remounted per open -- see the note above), and
  // read twice: by the form state and by the city verdict below it.
  const seededForm = useMemo(
    () => (template ? jobFormFromTemplatePayload(template.payload).form : initialForm),
    [template],
  );
  const [form, setForm] = useState<JobForm>(seededForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  /*
   * "The stored template has no city."
   *
   * A template payload that lost its `city_key` still carries its location
   * TEXT, so the picker opened looking settled and the save was then refused
   * with a sentence under the footer that pointed at no field. Asked of the
   * validator rather than of `city_key` directly, so it agrees with whatever
   * the save will actually accept (a failed location dataset makes free text
   * legal, and an empty location is a different error's business).
   */
  const [cityMissing, setCityMissing] = useState(
    () => validateStepBasics(seededForm) === 'location_pick_required',
  );
  // The template cap is not a "save failed" sentence -- it is a plan decision
  // with its own copy, its own way out, and no dismiss. `lib/plan-limit` owns
  // all three; this modal only decides where the notice sits.
  const [limitModel, setLimitModel] = useState<PlanLimitModel | null>(null);

  // The name is this form's one field the job form does not have; it is also
  // where editing starts, so the Modal lands initial focus on it.
  const nameRef = useRef<HTMLInputElement>(null);
  // See PostJobModal's identical pair: `ui/modal.tsx` renders `footer` as a
  // sibling of `children`, so Save is associated with the fields' form by id
  // rather than by containment, and a hidden descendant submit button is what
  // gives the form a default button for Enter.
  const formId = useId();

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
        // The sentence says what is wrong; the ring says where.
        setCityMissing(true);
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

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    void handleSubmit();
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
            <Button type="button" variant="ghost" onClick={handleClose} disabled={loading} className="flex-1">
              {t('modal.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
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
      <form id={formId} onSubmit={handleFormSubmit} className="grid gap-4">
        {/* The form's default button, so Enter in any field saves. See
            PostJobModal's copy of this comment for why it cannot simply be
            the footer's Save. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.name_label')} *</label>
          <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          {nameError && <p className="text-xs font-semibold text-[var(--jale-danger)]">{nameError}</p>}
        </div>

        <JobFormFields
          form={form}
          onUpdate={update}
          onLocationChange={(v) => {
            setForm((c) => applyLocationToJobForm(c, v));
            // A real pick resolves both the ring and the sentence; typing does
            // not -- free text still leaves `city_key` null.
            if (v.cityKey) {
              setCityMissing(false);
              setError('');
            }
          }}
          showStartDate={false}
          locationInvalid={cityMissing}
        />
      </form>
    </Modal>
  );
}
