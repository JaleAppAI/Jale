'use client';
import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, createJob, Job } from '@/lib/api/employer';
import {
  DOC_TYPES, LANGUAGE_OPTIONS, TRADE_CATEGORIES, PAY_INTERVALS,
  type DocType, type PayInterval, type JobForm,
  initialForm, jobFormToPayload, validateJobNumbers, applyLocationToJobForm,
} from '@/lib/job-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { locationDatasetFailed } from '@/lib/location-search';

interface Props {
  open: boolean;
  onClose: () => void;
  onJobCreated: (job: Job) => void;
}

export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  const { idToken } = useAuth();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<JobForm>(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limitReached, setLimitReached] = useState(false);

  if (!open) return null;

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    setStep(1);
    setForm(initialForm);
    setError('');
    setLimitReached(false);
    onClose();
  };

  const toggleDoc = (doc: DocType) => {
    setForm((current) => ({
      ...current,
      required_docs: { ...current.required_docs, [doc]: !current.required_docs[doc] },
    }));
  };

  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    setForm((current) => {
      if (value === 'any') return { ...current, language_preference: ['any'] };
      const withoutAny = current.language_preference.filter((item) => item !== 'any');
      const next = withoutAny.includes(value)
        ? withoutAny.filter((item) => item !== value)
        : [...withoutAny, value];
      return { ...current, language_preference: next.length > 0 ? next : ['any'] };
    });
  };

  const validateCurrentStep = (): string | null => {
    if (step === 1) {
      if (!form.title.trim() || !form.location.trim() || !form.trade_category) return t('modal.validation_required');
      if (!form.city_key && !locationDatasetFailed()) return t('modal.location_pick_required');
      return null;
    }
    if (step === 2) {
      const code = validateJobNumbers(form);
      if (code === 'number') return t('modal.validation_number');
      if (code === 'pay_range') return t('modal.validation_pay_range');
      if (code === 'headcount') return t('modal.validation_headcount');
    }
    return null;
  };

  const nextStep = () => {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setStep((current) => current === 1 ? 2 : 3);
  };

  const handleSubmit = async () => {
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError('');
    setLimitReached(false);
    try {
      const job = await createJob(idToken!, jobFormToPayload(form));
      onJobCreated(job);
      handleClose();
    } catch (err) {
      // Preserve every other validation error message as-is; only the typed
      // job_limit_reached code gets the upgrade CTA treatment.
      if (err instanceof ApiError && err.code === 'job_limit_reached') {
        setLimitReached(true);
        setError(tBilling('limit_reached.modal_message', {
          limit: err.payload.active_job_limit ?? 0,
        }));
      } else {
        setError(t('modal.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-3 py-4"
      style={{ background: 'rgba(24,24,85,.45)' }}
      onClick={handleClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-[var(--radius-card)] bg-white"
        style={{ boxShadow: 'var(--shadow-modal)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--jale-ink)]">{t('modal.title')}</h2>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
              {t('modal.step_label', { current: step, total: 3 })}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--jale-paper-2)]"
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--jale-ink-2)' }}
            aria-label={t('modal.close')}
          >
            x
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          {step === 1 && (
            <div className="grid gap-4">
              <Field label={t('modal.job_title')} required>
                <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder={t('modal.job_title_placeholder')} />
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('modal.location')} required>
                  <LocationPicker
                    value={form.location}
                    placeholder={t('modal.location_placeholder')}
                    onChange={(v) => {
                      setForm((c) => applyLocationToJobForm(c, v));
                      // A real pick resolves the "pick a city" error; drop it
                      // immediately instead of waiting for the next step.
                      if (v.cityKey) setError('');
                    }}
                  />
                </Field>
                <Field label={t('modal.job_type')}>
                  <Select value={form.job_type} onChange={(e) => update('job_type', e.target.value as JobForm['job_type'])}>
                    <option value="full-time">{t('modal.job_type_fulltime')}</option>
                    <option value="part-time">{t('modal.job_type_parttime')}</option>
                    <option value="contract">{t('modal.job_type_contract')}</option>
                  </Select>
                </Field>
              </div>
              <Field label={t('modal.trade_category')} required>
                <Select value={form.trade_category} onChange={(e) => update('trade_category', e.target.value as JobForm['trade_category'])}>
                  <option value="">{t('modal.select_placeholder')}</option>
                  {TRADE_CATEGORIES.map((trade) => (
                    <option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('modal.job_description')}>
                <Textarea rows={4} value={form.description} onChange={(e) => update('description', e.target.value)} placeholder={t('modal.description_placeholder')} />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('modal.pay_min')}>
                  <Input type="number" min={0} value={form.pay_min} onChange={(e) => update('pay_min', e.target.value)} />
                </Field>
                <Field label={t('modal.pay_max')}>
                  <Input type="number" min={0} value={form.pay_max} onChange={(e) => update('pay_max', e.target.value)} />
                </Field>
              </div>
              <Field label={t('modal.pay_interval')}>
                <Select value={form.pay_interval} onChange={(e) => update('pay_interval', e.target.value as PayInterval)}>
                  {PAY_INTERVALS.map((interval) => (
                    <option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('modal.start_date')}>
                  <Input type="date" value={form.start_date} onChange={(e) => update('start_date', e.target.value)} />
                </Field>
                <Field label={t('modal.expected_duration')}>
                  <Input value={form.expected_duration} onChange={(e) => update('expected_duration', e.target.value)} placeholder={t('modal.duration_placeholder')} />
                </Field>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('modal.shift_schedule')}>
                  <Input value={form.shift_schedule} onChange={(e) => update('shift_schedule', e.target.value)} placeholder={t('modal.shift_placeholder')} />
                </Field>
                <Field label={t('modal.number_of_workers_needed')} required>
                  <Input type="number" min={1} value={form.number_of_workers_needed} onChange={(e) => update('number_of_workers_needed', e.target.value)} />
                </Field>
              </div>
              <Field label={t('modal.required_experience_years')}>
                <Input type="number" min={0} value={form.required_experience_years} onChange={(e) => update('required_experience_years', e.target.value)} />
              </Field>
              <Field label={t('modal.language_preference')}>
                <div className="flex flex-wrap gap-2">
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => toggleLanguage(lang)}
                      className="rounded-full border px-3 py-2 text-xs font-semibold"
                      style={{
                        borderColor: form.language_preference.includes(lang) ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
                        background: form.language_preference.includes(lang) ? 'var(--jale-blue-50)' : 'white',
                        color: form.language_preference.includes(lang) ? 'var(--jale-blue-700)' : 'var(--jale-ink)',
                      }}
                    >
                      {t(`modal.language.${lang}`)}
                    </button>
                  ))}
                </div>
              </Field>
              <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
                <input
                  type="checkbox"
                  checked={form.transportation_required}
                  onChange={(e) => update('transportation_required', e.target.checked)}
                />
                {t('modal.transportation_required')}
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
                <input
                  type="checkbox"
                  checked={form.work_authorization_required}
                  onChange={(e) => update('work_authorization_required', e.target.checked)}
                />
                {t('modal.work_authorization_required')}
              </label>
              <Field label={t('modal.certifications')}>
                <Input value={form.certifications} onChange={(e) => update('certifications', e.target.value)} placeholder={t('modal.certifications_placeholder')} />
              </Field>
            </div>
          )}

          {step === 3 && (
            <div>
              <p className="mb-4 text-sm text-[var(--jale-ink-2)]">{t('post_job_docs.subtitle')}</p>
              <div className="flex flex-col gap-2.5">
                {DOC_TYPES.map((doc) => (
                  <button
                    key={doc}
                    type="button"
                    onClick={() => toggleDoc(doc)}
                    className="flex items-center justify-between rounded-[10px] border px-4 py-3 text-left transition-all"
                    style={{
                      background: form.required_docs[doc] ? 'var(--jale-blue-50)' : 'var(--jale-paper-2)',
                      borderColor: form.required_docs[doc] ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
                    }}
                  >
                    <span className="text-sm font-medium text-[var(--jale-ink)]">{docLabel[doc]}</span>
                    <span className="text-xs font-semibold text-[var(--jale-blue-700)]">
                      {form.required_docs[doc] ? t('post_job_docs.required_label') : t('post_job_docs.optional_label')}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-2xl border border-[var(--jale-danger)]/30 bg-[var(--jale-danger-bg)] p-4">
              <p className="text-sm font-semibold text-[var(--jale-danger)]">{error}</p>
              {limitReached && (
                <Link
                  href="/employer/billing"
                  onClick={handleClose}
                  className="mt-3 inline-flex h-10 items-center justify-center rounded-full bg-[var(--jale-blue-900)] px-5 text-sm font-bold text-white hover:bg-[var(--jale-blue-950,#0e0e3d)]"
                >
                  {tBilling('limit_reached.cta')}
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--jale-divider)] px-5 py-4">
          {step === 1 ? (
            <Button variant="ghost" onClick={handleClose} className="flex-1">{t('modal.cancel')}</Button>
          ) : (
            <Button variant="ghost" onClick={() => setStep((current) => current === 3 ? 2 : 1)} disabled={loading} className="flex-1">
              {t('post_job_docs.back')}
            </Button>
          )}
          {step < 3 ? (
            <Button variant="deep" onClick={nextStep} className="flex-1">{t('modal.next')}</Button>
          ) : (
            <Button variant="deep" onClick={handleSubmit} loading={loading} loadingLabel={tCommon('loading')} className="flex-1">
              {t('post_job_docs.submit')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
