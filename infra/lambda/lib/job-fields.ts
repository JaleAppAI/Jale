export const JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
export const JOB_STATUSES = ['active', 'paused', 'filled', 'closed'] as const;
export const WRITABLE_JOB_STATUSES = ['active', 'paused', 'closed'] as const;
export const APPLICATION_STATUSES = ['pending', 'contacted', 'talking', 'hired', 'not_interested'] as const;
export const LEGACY_APPLICATION_STATUS_MAP: Record<string, ApplicationStatus> = {
  reviewed: 'contacted',
  rejected: 'not_interested',
};
export const DOC_TYPES = ['resume', 'driver_license', 'ssn'] as const;
export const LANGUAGE_PREFERENCES = ['any', 'en', 'es'] as const;
export const TRADE_CATEGORIES = [
  'electrician',
  'plumber',
  'carpenter',
  'concrete',
  'painting',
  'drywall',
  'general_labor',
  'other',
] as const;

export type JobType = typeof JOB_TYPES[number];
export type JobStatus = typeof JOB_STATUSES[number];
export type WritableJobStatus = typeof WRITABLE_JOB_STATUSES[number];
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];

export interface ParsedJobFields {
  pay_min: number | null;
  pay_max: number | null;
  start_date: string | null;
  expected_duration: string | null;
  shift_schedule: string | null;
  transportation_required: boolean;
  language_preference: string[];
  number_of_workers_needed: number;
  trade_category: string;
  required_experience_years: number | null;
  certifications: string[];
}

export type ParseJobFieldsResult =
  | { ok: true; value: ParsedJobFields }
  | { ok: false; error: string; valid?: readonly string[] };

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const MAX_PAY_DOLLARS = 9999;
const MAX_WORKERS_NEEDED = 500;
const MAX_REQUIRED_EXPERIENCE_YEARS = 80;
const MAX_CERTIFICATIONS = 20;
const MAX_CERTIFICATION_LENGTH = 200;

function optionalInteger(value: unknown, fieldName: string, maxValue?: number): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || (maxValue !== undefined && value > maxValue)) {
    return { ok: false, error: `invalid_${fieldName}` };
  }
  return { ok: true, value };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeStringArray(value: unknown, valid: readonly string[], fieldName: string): { ok: true; value: string[] } | { ok: false; error: string; valid: readonly string[] } {
  if (!Array.isArray(value) || value.length > valid.length * 2) return { ok: false, error: `invalid_${fieldName}`, valid };
  const normalized = Array.from(new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)));
  if (normalized.length === 0 || normalized.some((item) => !valid.includes(item))) {
    return { ok: false, error: `invalid_${fieldName}`, valid };
  }
  return { ok: true, value: normalized };
}

export function normalizeApplicationStatus(status: string): ApplicationStatus | null {
  const mapped = LEGACY_APPLICATION_STATUS_MAP[status] ?? status;
  return APPLICATION_STATUSES.includes(mapped as ApplicationStatus) ? (mapped as ApplicationStatus) : null;
}

export function parseRequiredDocs(value: unknown): { ok: true; value: string[] } | { ok: false; error: string; valid: readonly string[] } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.some((doc) => typeof doc !== 'string' || !DOC_TYPES.includes(doc as any))) {
    return { ok: false, error: 'invalid_required_docs', valid: DOC_TYPES };
  }
  return { ok: true, value: Array.from(new Set(value)) };
}

export function parseJobFields(body: Record<string, unknown>): ParseJobFieldsResult {
  const payMin = optionalInteger(body.pay_min, 'pay_min', MAX_PAY_DOLLARS);
  if (!payMin.ok) return payMin;
  const payMax = optionalInteger(body.pay_max, 'pay_max', MAX_PAY_DOLLARS);
  if (!payMax.ok) return payMax;
  if (payMin.value !== null && payMax.value !== null && payMin.value > payMax.value) {
    return { ok: false, error: 'invalid_pay_range' };
  }

  const startDate = optionalString(body.start_date);
  if (startDate !== null && !isValidIsoDate(startDate)) {
    return { ok: false, error: 'invalid_start_date' };
  }

  const transportationRequired = body.transportation_required ?? false;
  if (typeof transportationRequired !== 'boolean') {
    return { ok: false, error: 'invalid_transportation_required' };
  }

  const language = normalizeStringArray(body.language_preference ?? ['any'], LANGUAGE_PREFERENCES, 'language_preference');
  if (!language.ok) return language;
  if (language.value.includes('any') && language.value.length > 1) {
    return { ok: false, error: 'invalid_language_preference', valid: LANGUAGE_PREFERENCES };
  }

  const workersNeeded = body.number_of_workers_needed ?? 1;
  if (typeof workersNeeded !== 'number' || !Number.isInteger(workersNeeded) || workersNeeded < 1 || workersNeeded > MAX_WORKERS_NEEDED) {
    return { ok: false, error: 'invalid_number_of_workers_needed' };
  }

  const tradeCategory = body.trade_category;
  if (typeof tradeCategory !== 'string' || !TRADE_CATEGORIES.includes(tradeCategory as any)) {
    return { ok: false, error: 'invalid_trade_category', valid: TRADE_CATEGORIES };
  }

  const requiredExperience = optionalInteger(body.required_experience_years, 'required_experience_years', MAX_REQUIRED_EXPERIENCE_YEARS);
  if (!requiredExperience.ok) return requiredExperience;

  let certifications: string[] = [];
  if (body.certifications !== undefined) {
    if (
      !Array.isArray(body.certifications) ||
      body.certifications.length > MAX_CERTIFICATIONS ||
      body.certifications.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.trim().length > MAX_CERTIFICATION_LENGTH)
    ) {
      return { ok: false, error: 'invalid_certifications' };
    }
    certifications = Array.from(new Set(body.certifications.map((item) => item.trim())));
  }

  return {
    ok: true,
    value: {
      pay_min: payMin.value,
      pay_max: payMax.value,
      start_date: startDate,
      expected_duration: optionalString(body.expected_duration),
      shift_schedule: optionalString(body.shift_schedule),
      transportation_required: transportationRequired,
      language_preference: language.value,
      number_of_workers_needed: workersNeeded,
      trade_category: tradeCategory,
      required_experience_years: requiredExperience.value,
      certifications,
    },
  };
}

export function formatPayRange(payMin: number | null, payMax: number | null): string | null {
  if (payMin === null && payMax === null) return null;
  if (payMin !== null && payMax !== null) return payMin === payMax ? `$${payMin}` : `$${payMin}-$${payMax}`;
  if (payMin !== null) return `From $${payMin}`;
  return `Up to $${payMax}`;
}
