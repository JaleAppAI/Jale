'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, updateJob, type EmployerJobDetail } from '@/lib/api/employer';
import {
  type JobForm,
  jobFormToEditPayload, jobToForm, validateJobNumbers, applyLocationToJobForm, validateJobLocationFields,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { JobFormFields } from '@/components/employer/JobFormFields';
import { locationDatasetFailed } from '@/lib/location-search';

interface Props {
  open: boolean;
  job: EmployerJobDetail;
  onClose: () => void;
  onJobUpdated: (job: EmployerJobDetail) => void;
}

export function EditJobModal({ open, job, onClose, onJobUpdated }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const { idToken } = useAuth();

  const [form, setForm] = useState<JobForm>(() => jobToForm(job));
  // Snapshot of the form as it was prefilled, so jobFormToEditPayload can
  // tell "started blank, still blank" (omit the key) apart from "started
  // with a value, now blanked" (send an explicit clear). Captured once, not
  // re-derived from `job`, so edits within this session can't shift it.
  const [initialForm] = useState<JobForm>(() => jobToForm(job));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const locked = job.applicant_count > 0;
  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleSubmit = async () => {
    if (!form.title.trim() || !form.location.trim() || !form.trade_category) {
      setError(t('modal.validation_required'));
      return;
    }
    if (!form.city_key && !locationDatasetFailed()) {
      setError(t('modal.location_pick_required'));
      return;
    }
    const code = validateJobNumbers(form);
    if (code === 'number') return setError(t('modal.validation_number'));
    if (code === 'pay_range') return setError(t('modal.validation_pay_range'));
    if (code === 'headcount') return setError(t('modal.validation_headcount'));
    if (validateJobLocationFields(form) === 'state_region') return setError(t('modal.validation_state_region'));
    if (Number(form.number_of_workers_needed) < job.hired_count) {
      return setError(t('modal.validation_headcount'));
    }
    setLoading(true);
    setError('');
    try {
      const updated = await updateJob(idToken!, job.id, jobFormToEditPayload(form, initialForm));
      onJobUpdated(updated);
      onClose();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError(code === 'field_locked' ? t('modal.locked_note') : t('modal.edit_error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-3 py-4" style={{ background: 'rgba(24,24,85,.45)' }} onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-[var(--radius-card)] bg-white" style={{ boxShadow: 'var(--shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--jale-ink)]">{t('modal.edit_title')}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--jale-paper-2)]" style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--jale-ink-2)' }} aria-label={t('modal.close')}>x</button>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-5">
          <JobFormFields
            form={form}
            onUpdate={update}
            onLocationChange={(v) => {
              setForm((c) => applyLocationToJobForm(c, v));
              // A real pick resolves the "pick a city" error; drop it
              // immediately instead of waiting for the next save attempt.
              if (v.cityKey) setError('');
            }}
            locked={locked}
            minWorkers={job.hired_count || 1}
          />

          {error && (
            <div className="rounded-2xl border border-[var(--jale-danger)]/30 bg-[var(--jale-danger-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--jale-danger)]">{error}</p>
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--jale-divider)] px-5 py-4">
          <Button variant="ghost" onClick={onClose} disabled={loading} className="flex-1">{t('modal.cancel')}</Button>
          <Button variant="deep" onClick={handleSubmit} loading={loading} loadingLabel={tCommon('loading')} className="flex-1">{t('modal.edit_save')}</Button>
        </div>
      </div>
    </div>
  );
}
