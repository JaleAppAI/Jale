export const JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
export const JOB_STATUSES = ['active', 'paused', 'filled', 'closed'] as const;
export const WRITABLE_JOB_STATUSES = ['active', 'paused', 'closed'] as const;
export const APPLICATION_STATUSES = ['pending', 'contacted', 'talking', 'hired', 'not_interested'] as const;
export const LEGACY_APPLICATION_STATUS_MAP: Record<string, ApplicationStatus> = {
  reviewed: 'contacted',
  rejected: 'not_interested',
};
export const DOC_TYPES = ['resume', 'driver_license'] as const;
export const LANGUAGE_PREFERENCES = ['any', 'en', 'es'] as const;
export const PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
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
export type PayInterval = typeof PAY_INTERVALS[number];

export interface ParsedJobFields {
  pay_min: number | null;
  pay_max: number | null;
  pay_interval: PayInterval | null;
  start_date: string | null;
  expected_duration: string | null;
  shift_schedule: string | null;
  transportation_required: boolean;
  work_authorization_required: boolean;
  language_preference: string[];
  number_of_workers_needed: number;
  trade_category: string;
  required_experience_years: number | null;
  required_experience_months: number | null;
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
const MAX_REQUIRED_EXPERIENCE_MONTHS = MAX_REQUIRED_EXPERIENCE_YEARS * 12;
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

  const payInterval = body.pay_interval ?? null;
  if (payInterval !== null && (typeof payInterval !== 'string' || !PAY_INTERVALS.includes(payInterval as PayInterval))) {
    return { ok: false, error: 'invalid_pay_interval', valid: PAY_INTERVALS };
  }

  const startDate = optionalString(body.start_date);
  if (startDate !== null && !isValidIsoDate(startDate)) {
    return { ok: false, error: 'invalid_start_date' };
  }

  const transportationRequired = body.transportation_required ?? false;
  if (typeof transportationRequired !== 'boolean') {
    return { ok: false, error: 'invalid_transportation_required' };
  }

  const workAuthorizationRequired = body.work_authorization_required ?? false;
  if (typeof workAuthorizationRequired !== 'boolean') {
    return { ok: false, error: 'invalid_work_authorization_required' };
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

  const requiredExperienceMonths = optionalInteger(body.required_experience_months, 'required_experience_months', MAX_REQUIRED_EXPERIENCE_MONTHS);
  if (!requiredExperienceMonths.ok) return requiredExperienceMonths;
  const requiredExperienceYears = optionalInteger(body.required_experience_years, 'required_experience_years', MAX_REQUIRED_EXPERIENCE_YEARS);
  if (!requiredExperienceYears.ok) return requiredExperienceYears;
  const canonicalRequiredExperienceMonths = requiredExperienceMonths.value ?? (requiredExperienceYears.value === null ? null : requiredExperienceYears.value * 12);

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
      pay_interval: payInterval as PayInterval | null,
      start_date: startDate,
      expected_duration: optionalString(body.expected_duration),
      shift_schedule: optionalString(body.shift_schedule),
      transportation_required: transportationRequired,
      work_authorization_required: workAuthorizationRequired,
      language_preference: language.value,
      number_of_workers_needed: workersNeeded,
      trade_category: tradeCategory,
      required_experience_years: requiredExperienceYears.value,
      required_experience_months: canonicalRequiredExperienceMonths,
      certifications,
    },
  };
}

export interface ParsedCoordinates {
  latitude: number;
  longitude: number;
}

export type ParseCoordinatesResult =
  | { ok: true; value: ParsedCoordinates | null }
  | { ok: false; error: 'invalid_coordinates' | 'invalid_latitude' | 'invalid_longitude' };

/**
 * All-or-none parse of an optional latitude/longitude pair on a request body.
 * ok+null  → neither field present (the caller leaves any existing pin alone).
 * ok+value → a complete, in-range pair.
 * error    → only one of the two present, or a value that is not a finite
 *            in-range number. Presence is hasOwnProperty-based, so an explicit
 *            `null` counts as present and fails validation rather than being
 *            treated as an omission.
 */
export function parseOptionalCoordinates(body: Record<string, unknown>): ParseCoordinatesResult {
  const hasLatitude = Object.prototype.hasOwnProperty.call(body, 'latitude');
  const hasLongitude = Object.prototype.hasOwnProperty.call(body, 'longitude');
  if (hasLatitude !== hasLongitude) return { ok: false, error: 'invalid_coordinates' };
  if (!hasLatitude) return { ok: true, value: null };

  const { latitude, longitude } = body;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, error: 'invalid_latitude' };
  }
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: 'invalid_longitude' };
  }
  return { ok: true, value: { latitude, longitude } };
}

export function formatPayRange(payMin: number | null, payMax: number | null): string | null {
  if (payMin === null && payMax === null) return null;
  if (payMin !== null && payMax !== null) return payMin === payMax ? `$${payMin}` : `$${payMin}-$${payMax}`;
  if (payMin !== null) return `From $${payMin}`;
  return `Up to $${payMax}`;
}

/** Locale supported by the worker-facing WhatsApp/localized pay renderers. */
export type PayLocale = 'en' | 'es';

/**
 * Per-interval suffix appended to the numeric pay range. `fixed` reads as a
 * parenthetical qualifier ("(fixed)"/"(fijo)") rather than a per-unit rate,
 * so it gets a leading space instead of the `/unit` slash the other
 * intervals use. ASCII-only Spanish (no accents), matching the convention
 * already used for outbound WhatsApp copy (see onboarding-renderers.ts /
 * templates.ts) — so "dia" not "día".
 */
const PAY_INTERVAL_SUFFIX: Record<PayInterval, Record<PayLocale, string>> = {
  hourly: { en: '/hour', es: '/hora' },
  daily: { en: '/day', es: '/dia' },
  weekly: { en: '/week', es: '/semana' },
  monthly: { en: '/month', es: '/mes' },
  fixed: { en: ' (fixed)', es: ' (fijo)' },
};

/**
 * Locale-aware counterpart to `formatPayRange()`. The stored `jobs.pay`
 * column (built by `formatPayRange()` at job create/update time) stays
 * English-only and untouched by this function — this is additive, for
 * worker-facing renders that have the structured `pay_min`/`pay_max`/
 * `pay_interval` fields available and want localized text instead of the
 * legacy server-persisted string.
 *
 * Mirrors `formatPayRange()`'s null/range/one-sided shape and appends an
 * interval suffix when known. Returns null when both bounds are null —
 * callers are responsible for their own localized "not specified" fallback
 * (see `payNotSpecifiedLabel`), same contract as `formatPayRange()`.
 */
export function formatPayRangeLocalized(
  payMin: number | null,
  payMax: number | null,
  payInterval: PayInterval | string | null,
  locale: PayLocale,
): string | null {
  if (payMin === null && payMax === null) return null;

  let base: string;
  if (payMin !== null && payMax !== null) {
    base = payMin === payMax ? `$${payMin}` : `$${payMin}-$${payMax}`;
  } else if (payMin !== null) {
    base = locale === 'es' ? `Desde $${payMin}` : `From $${payMin}`;
  } else {
    base = locale === 'es' ? `Hasta $${payMax}` : `Up to $${payMax}`;
  }

  const suffix =
    payInterval && Object.prototype.hasOwnProperty.call(PAY_INTERVAL_SUFFIX, payInterval)
      ? PAY_INTERVAL_SUFFIX[payInterval as PayInterval][locale]
      : '';
  return `${base}${suffix}`;
}

/** Localized "pay not specified" fallback — used when neither the
 * structured fields nor the legacy `jobs.pay` string have anything to
 * render. Kept ASCII-only to match the rest of the outbound Spanish copy. */
export function payNotSpecifiedLabel(locale: PayLocale): string {
  return locale === 'es' ? 'Pago no especificado' : 'Pay not specified';
}
