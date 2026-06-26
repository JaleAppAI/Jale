'use client';
import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { createJob, Job } from '@/lib/api/employer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type DocType = 'resume' | 'driver_license';
const DOC_TYPES: DocType[] = ['resume', 'driver_license'];
const LANGUAGE_OPTIONS = ['any', 'en', 'es'] as const;
const TRADE_CATEGORIES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor', 'other'] as const;
const PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
type PayInterval = typeof PAY_INTERVALS[number];

type JobForm = {
  title: string;
  location: string;
  job_type: 'full-time' | 'part-time' | 'contract';
  description: string;
  pay_min: string;
  pay_max: string;
  pay_interval: PayInterval;
  start_date: string;
  expected_duration: string;
  shift_schedule: string;
  transportation_required: boolean;
  work_authorization_required: boolean;
  language_preference: Array<'any' | 'en' | 'es'>;
  number_of_workers_needed: string;
  trade_category: typeof TRADE_CATEGORIES[number] | '';
  required_experience_years: string;
  certifications: string;
  required_docs: Record<DocType, boolean>;
};

const initialForm: JobForm = {
  title: '',
  location: '',
  job_type: 'full-time',
  description: '',
  pay_min: '',
  pay_max: '',
  pay_interval: 'hourly',
  start_date: '',
  expected_duration: '',
  shift_schedule: '',
  transportation_required: false,
  work_authorization_required: false,
  language_preference: ['any'],
  number_of_workers_needed: '1',
  trade_category: '',
  required_experience_years: '',
  certifications: '',
  required_docs: { resume: false, driver_license: false },
};

interface Props {
  open: boolean;
  onClose: () => void;
  onJobCreated: (job: Job) => void;
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function splitCertifications(value: string): string[] {
  return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
}

export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const { idToken } = useAuth();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<JobForm>(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    setStep(1);
    setForm(initialForm);
    setError('');
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
      return null;
    }
    if (step === 2) {
      const payMin = parseOptionalNumber(form.pay_min);
      const payMax = parseOptionalNumber(form.pay_max);
      const workersNeeded = Number(form.number_of_workers_needed);
      const experience = parseOptionalNumber(form.required_experience_years);
      if (Number.isNaN(payMin) || Number.isNaN(payMax) || Number.isNaN(experience)) return t('modal.validation_number');
      if ((payMin !== null && payMin < 0) || (payMax !== null && payMax < 0)) return t('modal.validation_number');
      if (payMin !== null && payMax !== null && payMin > payMax) return t('modal.validation_pay_range');
      if (!Number.isInteger(workersNeeded) || workersNeeded < 1) return t('modal.validation_headcount');
      if (experience !== null && experience < 0) return t('modal.validation_number');
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
    try {
      const pay_min = parseOptionalNumber(form.pay_min);
      const pay_max = parseOptionalNumber(form.pay_max);
      const required_experience_years = parseOptionalNumber(form.required_experience_years);
      const required_docs = DOC_TYPES.filter((doc) => form.required_docs[doc]);
      const job = await createJob(idToken!, {
        title: form.title.trim(),
        location: form.location.trim(),
        job_type: form.job_type,
        description: form.description.trim() || undefined,
        required_docs,
        pay_min,
        pay_max,
        pay_interval: form.pay_interval,
        start_date: form.start_date || null,
        expected_duration: form.expected_duration.trim() || null,
        shift_schedule: form.shift_schedule.trim() || null,
        transportation_required: form.transportation_required,
        work_authorization_required: form.work_authorization_required,
        language_preference: form.language_preference,
        number_of_workers_needed: Number(form.number_of_workers_needed),
        trade_category: form.trade_category,
        required_experience_years,
        certifications: splitCertifications(form.certifications),
      });
      onJobCreated(job);
      handleClose();
    } catch {
      setError(t('modal.error'));
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
                  <Input value={form.location} onChange={(e) => update('location', e.target.value)} placeholder={t('modal.location_placeholder')} />
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

          {error && <p className="mt-4 text-sm text-[var(--jale-danger)]">{error}</p>}
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
