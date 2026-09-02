export const JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
export const JOB_STATUSES = ['active', 'paused', 'filled', 'closed'] as const;
export const WRITABLE_JOB_STATUSES = ['active', 'paused', 'closed'] as const;
// 'details_requested' (sprint 23) sits after 'talking': the employer has
// moved the applicant forward and asked them for the full requirement list
// (jobs.required_fields/required_docs/certification_requirements). It is a
// waypoint, not a terminal state -- the stage-2 fill is gated on the
// `details_requested_at`/`details_completed_at` TIMESTAMPTZ pair, never on
// this literal, so `details_requested -> contacted/talking` keeps the fill
// alive. Mirrors job_applications_status_check as rewritten by
// 091_application_stages.sql BY HAND. This array is also echoed verbatim as
// the `valid:` field of two 400 bodies (employer-application-status-update,
// employer-job-applicants).
export const APPLICATION_STATUSES = ['pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested'] as const;
export const LEGACY_APPLICATION_STATUS_MAP: Record<string, ApplicationStatus> = {
  reviewed: 'contacted',
  rejected: 'not_interested',
};
// 'ssn' is intentionally excluded: legacy jobs/worker_documents rows may
// still reference it (kept in the DB CHECK constraints for that reason),
// but no new job or upload may select it. See
// 073_job_application_requirements.sql and 032_work_authorization_required.sql.
export const DOC_TYPES = ['resume', 'driver_license', 'work_auth_doc', 'certification_doc'] as const;
export const LANGUAGE_PREFERENCES = ['any', 'en', 'es'] as const;
export const PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
// Per-job applicant-requirement checkboxes (jobs.required_fields). This is
// the source of truth for the app layer -- it must match the
// jobs_required_fields_valid CHECK added in
// 073_job_application_requirements.sql BY HAND; nothing enforces the two
// stay in sync automatically.
export const REQUIRED_FIELD_TYPES = [
  'work_authorization',
  'date_available',
  'desired_pay',
  'home_address',
  'date_of_birth',
  'emergency_contact',
  'worked_here_before',
  'education',
  'references',
  'work_history',
  'military_service',
] as const;
// Defense-in-depth cap on certification_doc uploads TOTAL per slot, mirrored
// by the trigger in 075_worker_documents_multi_certification.sql, RAISED
// from 5 to 20 by 078_worker_documents_cert_name.sql (see that migration's
// header: proof-required per-cert uploads need headroom beyond the old
// single-certification-file assumption).
export const MAX_CERTIFICATION_FILES = 20;
// Per-name cap within the same slot, introduced by
// 078_worker_documents_cert_name.sql alongside the total-cap raise above --
// see that migration's header for the full reachability analysis. This is
// now the BINDING limit for a same-name (or same-unlabeled) upload flood,
// since the total cap only binds once a slot holds >=20 rows across names.
export const MAX_CERTIFICATION_FILES_PER_NAME = 5;
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
// BE-T2: MUST byte-match the jobs_expected_duration_bucket_valid CHECK added
// by 077_jobs_structured_fields.sql. This sits ALONGSIDE the legacy free-text
// jobs.expected_duration column, not replacing it -- see that migration's
// header.
export const EXPECTED_DURATION_BUCKETS = ['lt_1w', '1_2w', '2_4w', '1_3m', '3_6m', '6m_plus', 'ongoing'] as const;
// BE-T2: MUST byte-match the jobs_work_days_valid CHECK's ARRAY[...] literal
// added by 077_jobs_structured_fields.sql.
export const WORK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type JobType = typeof JOB_TYPES[number];
export type JobStatus = typeof JOB_STATUSES[number];
export type WritableJobStatus = typeof WRITABLE_JOB_STATUSES[number];
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];
export type PayInterval = typeof PAY_INTERVALS[number];
export type ExpectedDurationBucket = typeof EXPECTED_DURATION_BUCKETS[number];
export type WorkDay = typeof WORK_DAYS[number];
export type CertificationTier = 'required' | 'optional';

// BE-T2 (077): shape validated app-side, matching the 073/074 precedent that
// per-entry validation of a JSON-shaped column stays out of SQL -- the
// jobs_certification_requirements_valid CHECK only enforces
// jsonb_typeof(...) = 'array'.
export interface CertificationRequirement {
  name: string;
  tier: CertificationTier;
  proof_required: boolean;
}

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
  // BE-T2 (077): additive, all optional -- a legacy payload with none of
  // these six keys parses with every one of them null, byte-identical to
  // today's shape otherwise. See parseJobFields for the derivation/
  // doc-conflict rule tying certification_requirements to `certifications`.
  trade_category_other: string | null;
  expected_duration_bucket: string | null;
  work_days: string[] | null;
  shift_start: string | null;
  shift_end: string | null;
  certification_requirements: CertificationRequirement[] | null;
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
// A-7 / T-A1 ride-along: shared by employer-jobs-create, employer-jobs-update,
// and employer-templates-save (all three call parseJobFields with the full
// request body), so this one check caps `description` on every write path
// without touching any of those three handlers. Measures the TRIMMED length
// to match the AI generation endpoint's own <=4000-trimmed-chars contract --
// a generated description that just clears that check must not then fail
// here on trailing whitespace alone.
const MAX_DESCRIPTION_LENGTH = 4000;
// BE-T2 (077): app-layer cap only -- jobs_trade_category_other_valid has no
// length constraint (see that migration's header), this mirrors the
// existing MAX_CERTIFICATION_LENGTH convention of capping free text the DB
// itself leaves unbounded.
const MAX_TRADE_CATEGORY_OTHER_LENGTH = 200;
// BE-T2 (077): cap on certification_requirements ARRAY LENGTH (distinct
// entries), not to be confused with MAX_CERTIFICATIONS (the legacy free-text
// certifications summary) or MAX_CERTIFICATION_FILES/_PER_NAME (worker
// upload counts, 078). App-layer only, same 073/074 precedent as the shape
// checks below.
const MAX_CERTIFICATION_REQUIREMENTS = 20;
// 24h HH:MM, matching the jobs.shift_start/shift_end TIME columns added by
// 077_jobs_structured_fields.sql.
const SHIFT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function optionalInteger(value: unknown, fieldName: string, maxValue?: number): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || (maxValue !== undefined && value > maxValue)) {
    return { ok: false, error: `invalid_${fieldName}` };
  }
  return { ok: true, value };
}

export function isValidIsoDate(value: string): boolean {
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

// NOTE: deliberately NOT part of ParsedJobFields/parseJobFields -- that
// type is spread into stored template payloads (see
// 069_employer_job_templates.sql), and required_fields is a standalone jobs
// column with its own CHECK, not a template payload field.
export function parseRequiredFields(value: unknown): { ok: true; value: string[] } | { ok: false; error: 'invalid_required_fields'; valid: readonly string[] } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.some((field) => typeof field !== 'string' || !REQUIRED_FIELD_TYPES.includes(field as any))) {
    return { ok: false, error: 'invalid_required_fields', valid: REQUIRED_FIELD_TYPES };
  }
  return { ok: true, value: Array.from(new Set(value)) };
}

// BE-T2 (077): one-way, mirroring jobs_trade_category_other_valid -- forbidden
// on any non-'other' category. Deliberately NOT required when tradeCategory
// IS 'other': legacy 'other' rows (and their template re-saves) predate this
// column and have trade_category_other NULL; the frontend enforces
// requiredness on new submissions, not this validator (see 077's header).
function parseTradeCategoryOther(value: unknown, tradeCategory: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = optionalString(value);
  if (trimmed === null) return { ok: true, value: null };
  if (tradeCategory !== 'other') return { ok: false, error: 'invalid_trade_category_other' };
  if (trimmed.length > MAX_TRADE_CATEGORY_OTHER_LENGTH) return { ok: false, error: 'invalid_trade_category_other' };
  return { ok: true, value: trimmed };
}

// BE-T2 (077): unlike normalizeStringArray (language_preference), duplicates
// are REJECTED here, not silently de-duped -- a duplicate day is a client bug
// worth surfacing, not noise to swallow.
function parseWorkDays(value: unknown): { ok: true; value: string[] | null } | { ok: false; error: string; valid: readonly string[] } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.some((day) => typeof day !== 'string' || !WORK_DAYS.includes(day as any))) {
    return { ok: false, error: 'invalid_work_days', valid: WORK_DAYS };
  }
  if (new Set(value).size !== value.length) {
    return { ok: false, error: 'invalid_work_days', valid: WORK_DAYS };
  }
  return { ok: true, value: value as string[] };
}

// BE-T2 (077): strict HH:MM match, independently optional -- no cross-check
// against the other of the pair (see 077's header: overnight shifts and
// one-sided shifts are both legitimate).
function parseShiftTime(value: unknown, fieldName: 'shift_start' | 'shift_end'): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || !SHIFT_TIME_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${fieldName}` };
  }
  return { ok: true, value };
}

// BE-T2 (077/078): shape-checked here, not in SQL (see 077's header). Caps
// entry count, per-entry name/tier/proof_required shape, and rejects
// case-insensitive duplicate names. Does NOT check for a certification_doc
// conflict -- that cross-field rule lives in parseJobFields, which is also
// where a non-empty result derives the legacy `certifications` TEXT[].
function parseCertificationRequirements(value: unknown): { ok: true; value: CertificationRequirement[] | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > MAX_CERTIFICATION_REQUIREMENTS) {
    return { ok: false, error: 'invalid_certification_requirements' };
  }

  const seenNames = new Set<string>();
  const parsed: CertificationRequirement[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'invalid_certification_requirements' };
    }
    const { name, tier, proof_required: proofRequired } = entry as Record<string, unknown>;
    if (typeof name !== 'string') return { ok: false, error: 'invalid_certification_requirements' };
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > MAX_CERTIFICATION_LENGTH) {
      return { ok: false, error: 'invalid_certification_requirements' };
    }
    if (tier !== 'required' && tier !== 'optional') {
      return { ok: false, error: 'invalid_certification_requirements' };
    }
    if (typeof proofRequired !== 'boolean') {
      return { ok: false, error: 'invalid_certification_requirements' };
    }
    const key = trimmedName.toLowerCase();
    if (seenNames.has(key)) {
      return { ok: false, error: 'invalid_certification_requirements' };
    }
    seenNames.add(key);
    parsed.push({ name: trimmedName, tier, proof_required: proofRequired });
  }
  return { ok: true, value: parsed };
}

export function parseJobFields(body: Record<string, unknown>): ParseJobFieldsResult {
  if (typeof body.description === 'string' && body.description.trim().length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: 'invalid_description' };
  }

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

  // BE-T2 (077): six new structured fields, all optional/additive.
  const tradeCategoryOther = parseTradeCategoryOther(body.trade_category_other, tradeCategory);
  if (!tradeCategoryOther.ok) return tradeCategoryOther;

  const expectedDurationBucket = body.expected_duration_bucket ?? null;
  if (expectedDurationBucket !== null && (typeof expectedDurationBucket !== 'string' || !EXPECTED_DURATION_BUCKETS.includes(expectedDurationBucket as any))) {
    return { ok: false, error: 'invalid_expected_duration_bucket', valid: EXPECTED_DURATION_BUCKETS };
  }

  const workDays = parseWorkDays(body.work_days);
  if (!workDays.ok) return workDays;

  const shiftStart = parseShiftTime(body.shift_start, 'shift_start');
  if (!shiftStart.ok) return shiftStart;
  const shiftEnd = parseShiftTime(body.shift_end, 'shift_end');
  if (!shiftEnd.ok) return shiftEnd;

  const certificationRequirements = parseCertificationRequirements(body.certification_requirements);
  if (!certificationRequirements.ok) return certificationRequirements;

  let certifications: string[] = [];
  if (certificationRequirements.value && certificationRequirements.value.length > 0) {
    // Doc-conflict rule (077/078): per-cert proofs replace the single
    // certification_doc row -- no double-gating an applicant on both. Reads
    // the RAW body arrays (not a caller-supplied parsed value) so this one
    // check covers employer-jobs-create.ts, employer-jobs-update.ts's create
    // path, and employer-templates-save.ts identically, since all three call
    // parseJobFields with the full request body. employer-jobs-update.ts's
    // field-edit path ALSO re-checks this against the EFFECTIVE
    // (post preserve-on-omit-merge) optional_docs, since a PATCH that omits
    // optional_docs entirely can inherit a stored conflict this raw check
    // cannot see.
    const requiredDocsRaw = Array.isArray(body.required_docs) ? body.required_docs : [];
    const optionalDocsRaw = Array.isArray(body.optional_docs) ? body.optional_docs : [];
    if (requiredDocsRaw.includes('certification_doc') || optionalDocsRaw.includes('certification_doc')) {
      return { ok: false, error: 'invalid_certification_requirements_doc_conflict' };
    }
    // Derived from names -- any client-supplied `certifications` is ignored
    // outright (not validated, then overridden): a stale/hostile legacy
    // value must never reject a payload that will discard it anyway.
    certifications = certificationRequirements.value.map((entry) => entry.name);
  } else if (body.certifications !== undefined) {
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
      trade_category_other: tradeCategoryOther.value,
      expected_duration_bucket: expectedDurationBucket as string | null,
      work_days: workDays.value,
      shift_start: shiftStart.value,
      shift_end: shiftEnd.value,
      certification_requirements: certificationRequirements.value,
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
