import { splitDedupe } from '@/lib/text';
import type { EmployerJobDetail, JobWritePayload } from '@/lib/api/employer';

export type DocType = 'resume' | 'driver_license';
export const DOC_TYPES: DocType[] = ['resume', 'driver_license'];
export const LANGUAGE_OPTIONS = ['any', 'en', 'es'] as const;
export const TRADE_CATEGORIES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor', 'other'] as const;
export const PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
export type PayInterval = typeof PAY_INTERVALS[number];

export type JobForm = {
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

export const initialForm: JobForm = {
  title: '', location: '', job_type: 'full-time', description: '',
  pay_min: '', pay_max: '', pay_interval: 'hourly', start_date: '',
  expected_duration: '', shift_schedule: '', transportation_required: false,
  work_authorization_required: false, language_preference: ['any'],
  number_of_workers_needed: '1', trade_category: '', required_experience_years: '',
  certifications: '', required_docs: { resume: false, driver_license: false },
};

export function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Pure validation of the numeric fields, shared by create + edit.
// Returns an error CODE (caller maps to a localized message), or null.
export function validateJobNumbers(form: JobForm): 'number' | 'pay_range' | 'headcount' | null {
  const payMin = parseOptionalNumber(form.pay_min);
  const payMax = parseOptionalNumber(form.pay_max);
  const workersNeeded = Number(form.number_of_workers_needed);
  const experience = parseOptionalNumber(form.required_experience_years);
  if (Number.isNaN(payMin) || Number.isNaN(payMax) || Number.isNaN(experience)) return 'number';
  if ((payMin !== null && payMin < 0) || (payMax !== null && payMax < 0)) return 'number';
  if (payMin !== null && payMax !== null && payMin > payMax) return 'pay_range';
  if (!Number.isInteger(workersNeeded) || workersNeeded < 1) return 'headcount';
  if (experience !== null && experience < 0) return 'number';
  return null;
}

export function jobFormToPayload(form: JobForm): JobWritePayload {
  return {
    title: form.title.trim(),
    location: form.location.trim(),
    job_type: form.job_type,
    description: form.description.trim() || undefined,
    required_docs: DOC_TYPES.filter((doc) => form.required_docs[doc]),
    pay_min: parseOptionalNumber(form.pay_min),
    pay_max: parseOptionalNumber(form.pay_max),
    pay_interval: form.pay_interval,
    start_date: form.start_date || null,
    expected_duration: form.expected_duration.trim() || null,
    shift_schedule: form.shift_schedule.trim() || null,
    transportation_required: form.transportation_required,
    work_authorization_required: form.work_authorization_required,
    language_preference: form.language_preference,
    number_of_workers_needed: Number(form.number_of_workers_needed),
    trade_category: form.trade_category as string,
    required_experience_years: parseOptionalNumber(form.required_experience_years),
    certifications: splitDedupe(form.certifications),
  };
}

// Prefill a JobForm from a loaded job (edit mode).
export function jobToForm(job: EmployerJobDetail): JobForm {
  return {
    title: job.title ?? '',
    location: job.location ?? '',
    job_type: job.job_type,
    description: job.description ?? '',
    pay_min: job.pay_min != null ? String(job.pay_min) : '',
    pay_max: job.pay_max != null ? String(job.pay_max) : '',
    pay_interval: (job.pay_interval as PayInterval) || 'hourly',
    start_date: job.start_date ? job.start_date.slice(0, 10) : '',
    expected_duration: job.expected_duration ?? '',
    shift_schedule: job.shift_schedule ?? '',
    transportation_required: job.transportation_required ?? false,
    work_authorization_required: job.work_authorization_required ?? false,
    language_preference: (job.language_preference?.length ? job.language_preference : ['any']) as JobForm['language_preference'],
    number_of_workers_needed: String(job.number_of_workers_needed ?? 1),
    trade_category: (job.trade_category as JobForm['trade_category']) ?? '',
    required_experience_years: job.required_experience_years != null ? String(job.required_experience_years) : '',
    certifications: (job.certifications ?? []).join(', '),
    required_docs: {
      resume: (job.required_docs ?? []).includes('resume'),
      driver_license: (job.required_docs ?? []).includes('driver_license'),
    },
  };
}
