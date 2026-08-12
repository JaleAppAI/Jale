'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, saveJobTemplate, type JobTemplate } from '@/lib/api/employer';
import {
  type JobForm, initialForm, jobFormFromTemplatePayload, jobFormToCreatePayload,
  validateJobNumbers, validateJobLocationFields, applyLocationToJobForm,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { JobFormFields } from '@/components/employer/JobFormFields';
import { Modal } from '@/components/ui/modal';
import { locationDatasetFailed } from '@/lib/location-search';

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
  const tBilling = useTranslations('billing');
  const { idToken } = useAuth();

  const [name, setName] = useState(template?.name ?? '');
  const [form, setForm] = useState<JobForm>(() =>
    template ? jobFormFromTemplatePayload(template.payload).form : initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [limitReached, setLimitReached] = useState(false);
  const [templateLimit, setTemplateLimit] = useState<number | null>(null);

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
    setLimitReached(false);
    setTemplateLimit(null);
    if (!name.trim()) return setNameError(t('templates.name_required'));
    if (!form.title.trim() || !form.location.trim() || !form.trade_category) {
      return setError(t('modal.validation_required'));
    }
    if (!form.city_key && !locationDatasetFailed()) {
      return setError(t('modal.location_pick_required'));
    }
    const code = validateJobNumbers(form);
    if (code === 'number') return setError(t('modal.validation_number'));
    if (code === 'pay_range') return setError(t('modal.validation_pay_range'));
    if (code === 'headcount') return setError(t('modal.validation_headcount'));
    if (validateJobLocationFields(form) === 'state_region') return setError(t('modal.validation_state_region'));
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
        setError(t('modal.template_limit_reached'));
        setTemplateLimit(err.payload.template_limit ?? null);
        setLimitReached(true);
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
            <InlineFeedback tone="danger" onDismiss={limitReached ? undefined : () => setError('')}>
              <span
                className="block"
                title={templateLimit != null ? String(templateLimit) : undefined}
              >
                {error}
              </span>
              {limitReached ? (
                <Link
                  href="/employer/billing"
                  onClick={onClose}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                >
                  <Icon name="spark" />
                  {tBilling('limit_reached.cta')}
                </Link>
              ) : null}
            </InlineFeedback>
          ) : null}
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
