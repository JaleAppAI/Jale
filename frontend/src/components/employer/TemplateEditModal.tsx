'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, saveJobTemplate, type JobTemplate } from '@/lib/api/employer';
import {
  type JobForm, initialForm, jobFormFromTemplatePayload, jobFormToCreatePayload,
  validateJobNumbers, validateJobLocationFields, applyLocationToJobForm,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JobFormFields } from '@/components/employer/JobFormFields';
import { locationDatasetFailed } from '@/lib/location-search';
import { Link } from '@/i18n/navigation';

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

  if (!open) return null;

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleSubmit = async () => {
    setNameError('');
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
    setError('');
    setLimitReached(false);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center px-3 py-4" style={{ background: 'rgba(24,24,85,.45)' }} onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-[var(--radius-card)] bg-white" style={{ boxShadow: 'var(--shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--jale-ink)]">{template ? t('templates.edit_title') : t('templates.new_title')}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--jale-paper-2)]" style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--jale-ink-2)' }} aria-label={t('modal.close')}>x</button>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('templates.name_label')} *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            {nameError && <p className="text-xs font-semibold text-[var(--jale-danger)]">{nameError}</p>}
          </div>

          <JobFormFields
            form={form}
            onUpdate={update}
            onLocationChange={(v) => setForm((c) => applyLocationToJobForm(c, v))}
            showStartDate={false}
          />

          {error && (
            <div className="rounded-2xl border border-[var(--jale-danger)]/30 bg-[var(--jale-danger-bg)] p-4">
              <p
                className="text-sm font-semibold text-[var(--jale-danger)]"
                title={templateLimit != null ? String(templateLimit) : undefined}
              >
                {error}
              </p>
              {limitReached && (
                <Link
                  href="/employer/billing"
                  onClick={onClose}
                  className="mt-2 inline-flex h-8 items-center justify-center rounded-full bg-[var(--jale-blue-900)] px-4 text-xs font-bold text-white hover:bg-[var(--jale-blue-950,#0e0e3d)]"
                >
                  {tBilling('limit_reached.cta')}
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--jale-divider)] px-5 py-4">
          <Button variant="ghost" onClick={onClose} disabled={loading} className="flex-1">{t('modal.cancel')}</Button>
          <Button variant="deep" onClick={handleSubmit} loading={loading} loadingLabel={tCommon('loading')} className="flex-1">{t('templates.save')}</Button>
        </div>
      </div>
    </div>
  );
}
