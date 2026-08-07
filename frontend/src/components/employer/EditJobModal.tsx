'use client';
import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, updateJob, type EmployerJobDetail } from '@/lib/api/employer';
import {
  DOC_TYPES, LANGUAGE_OPTIONS, TRADE_CATEGORIES, PAY_INTERVALS,
  type DocType, type PayInterval, type JobForm,
  jobFormToEditPayload, jobToForm, validateJobNumbers, applyLocationToJobForm, validateJobLocationFields,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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

  const toggleDoc = (doc: DocType) => {
    if (locked) return;
    setForm((current) => ({ ...current, required_docs: { ...current.required_docs, [doc]: !current.required_docs[doc] } }));
  };
  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    setForm((current) => {
      if (value === 'any') return { ...current, language_preference: ['any'] };
      const withoutAny = current.language_preference.filter((i) => i !== 'any');
      const next = withoutAny.includes(value) ? withoutAny.filter((i) => i !== value) : [...withoutAny, value];
      return { ...current, language_preference: next.length > 0 ? next : ['any'] };
    });
  };

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

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-3 py-4" style={{ background: 'rgba(24,24,85,.45)' }} onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-[var(--radius-card)] bg-white" style={{ boxShadow: 'var(--shadow-modal)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--jale-ink)]">{t('modal.edit_title')}</h2>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--jale-paper-2)]" style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--jale-ink-2)' }} aria-label={t('modal.close')}>x</button>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-5">
          <Field label={t('modal.job_title')} required>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.location')} required>
              <LocationPicker
                value={form.location}
                onChange={(v) => {
                  setForm((c) => applyLocationToJobForm(c, v));
                  // A real pick resolves the "pick a city" error; drop it
                  // immediately instead of waiting for the next save attempt.
                  if (v.cityKey) setError('');
                }}
              />
            </Field>
            <Field label={t('modal.job_type')}>
              <Select value={form.job_type} onChange={(e) => update('job_type', e.target.value as JobForm['job_type'])} disabled={locked}>
                <option value="full-time">{t('modal.job_type_fulltime')}</option>
                <option value="part-time">{t('modal.job_type_parttime')}</option>
                <option value="contract">{t('modal.job_type_contract')}</option>
              </Select>
            </Field>
          </div>
          <Field label={t('modal.trade_category')} required>
            <Select value={form.trade_category} onChange={(e) => update('trade_category', e.target.value as JobForm['trade_category'])}>
              <option value="">{t('modal.select_placeholder')}</option>
              {TRADE_CATEGORIES.map((trade) => (<option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>))}
            </Select>
          </Field>
          <Field label={t('modal.job_description')}>
            <Textarea rows={4} value={form.description} onChange={(e) => update('description', e.target.value)} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.pay_min')}><Input type="number" min={0} value={form.pay_min} onChange={(e) => update('pay_min', e.target.value)} /></Field>
            <Field label={t('modal.pay_max')}><Input type="number" min={0} value={form.pay_max} onChange={(e) => update('pay_max', e.target.value)} /></Field>
          </div>
          <Field label={t('modal.pay_interval')}>
            <Select value={form.pay_interval} onChange={(e) => update('pay_interval', e.target.value as PayInterval)}>
              {PAY_INTERVALS.map((interval) => (<option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>))}
            </Select>
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.start_date')}><Input type="date" value={form.start_date} onChange={(e) => update('start_date', e.target.value)} /></Field>
            <Field label={t('modal.expected_duration')}><Input value={form.expected_duration} onChange={(e) => update('expected_duration', e.target.value)} /></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t('modal.shift_schedule')}><Input value={form.shift_schedule} onChange={(e) => update('shift_schedule', e.target.value)} /></Field>
            <Field label={t('modal.number_of_workers_needed')} required>
              <Input type="number" min={job.hired_count || 1} value={form.number_of_workers_needed} onChange={(e) => update('number_of_workers_needed', e.target.value)} />
            </Field>
          </div>
          <Field label={t('modal.required_experience_years')}>
            <Input type="number" min={0} value={form.required_experience_years} onChange={(e) => update('required_experience_years', e.target.value)} />
          </Field>
          <Field label={t('modal.language_preference')}>
            <div className="flex flex-wrap gap-2">
              {LANGUAGE_OPTIONS.map((lang) => (
                <button key={lang} type="button" onClick={() => toggleLanguage(lang)} className="rounded-full border px-3 py-2 text-xs font-semibold" style={{
                  borderColor: form.language_preference.includes(lang) ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
                  background: form.language_preference.includes(lang) ? 'var(--jale-blue-50)' : 'white',
                  color: form.language_preference.includes(lang) ? 'var(--jale-blue-700)' : 'var(--jale-ink)',
                }}>{t(`modal.language.${lang}`)}</button>
              ))}
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
            <input type="checkbox" checked={form.transportation_required} onChange={(e) => update('transportation_required', e.target.checked)} />
            {t('modal.transportation_required')}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
            <input type="checkbox" checked={form.work_authorization_required} onChange={(e) => update('work_authorization_required', e.target.checked)} />
            {t('modal.work_authorization_required')}
          </label>
          <Field label={t('modal.certifications')}>
            <Input value={form.certifications} onChange={(e) => update('certifications', e.target.value)} />
          </Field>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('post_job_docs.subtitle')}</p>
            {locked && <p className="mb-2 text-xs font-semibold text-[var(--jale-ink-2)]">{t('modal.locked_note')}</p>}
            <div className="flex flex-col gap-2.5">
              {DOC_TYPES.map((doc) => (
                <button key={doc} type="button" onClick={() => toggleDoc(doc)} disabled={locked}
                  className="flex items-center justify-between rounded-[10px] border px-4 py-3 text-left transition-all disabled:opacity-60"
                  style={{ background: form.required_docs[doc] ? 'var(--jale-blue-50)' : 'var(--jale-paper-2)', borderColor: form.required_docs[doc] ? 'var(--jale-blue-500)' : 'var(--jale-divider)' }}>
                  <span className="text-sm font-medium text-[var(--jale-ink)]">{docLabel[doc]}</span>
                  <span className="text-xs font-semibold text-[var(--jale-blue-700)]">{form.required_docs[doc] ? t('post_job_docs.required_label') : t('post_job_docs.optional_label')}</span>
                </button>
              ))}
            </div>
          </div>

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

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}{required ? ' *' : ''}</label>
      {children}
    </div>
  );
}
