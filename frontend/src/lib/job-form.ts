import { splitDedupe } from '@/lib/text';
import type { EmployerJobDetail, JobWritePayload } from '@/lib/api/employer';
import {
  type RequirementsMap,
  initialRequirements,
  requirementsToArrays,
  arraysToRequirements,
} from '@/lib/job-requirements';
export type { RequirementsMap } from '@/lib/job-requirements';
export {
  REQUIREMENT_DOC_KEYS,
  REQUIREMENT_FIELD_KEYS,
  REQUIREMENT_KEYS,
  FIELD_GROUPS,
  initialRequirements,
  requirementsToArrays,
  arraysToRequirements,
  setRequirementState,
  countRequirements,
  certificationHintNames,
} from '@/lib/job-requirements';
export type {
  RequirementKey,
  RequirementDocKey,
  RequirementFieldKey,
  RequirementState,
} from '@/lib/job-requirements';

export const LANGUAGE_OPTIONS = ['any', 'en', 'es'] as const;
export const TRADE_CATEGORIES = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor', 'other'] as const;
export const PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
export type PayInterval = typeof PAY_INTERVALS[number];

export type JobForm = {
  title: string;
  location: string;
  city_key: string | null;
  city: string | null;
  state: string | null;
  /** Independent SEO-region override (backend: resolveJobLocationFields).
   *  Always a string (never null) in form state -- blank means "not set" and
   *  serializes to an explicit `null` clear on the wire, same as the picker
   *  fields' blank/cleared state. */
  state_region: string;
  latitude: number | null;
  longitude: number | null;
  job_type: 'full-time' | 'part-time' | 'contract';
  description: string;
  pay_min: string;
  pay_max: string;
  pay_interval: PayInterval;
  start_date: string;
  expected_duration: string;
  shift_schedule: string;
  transportation_required: boolean;
  language_preference: Array<'any' | 'en' | 'es'>;
  number_of_workers_needed: string;
  trade_category: typeof TRADE_CATEGORIES[number] | '';
  required_experience_years: string;
  certifications: string;
  /**
   * Three-state Off/Optional/Required per data point (docs + fields), owned
   * by `RequirementsPicker`. There is no separate `work_authorization_required`
   * input any more -- `requirements.work_authorization` is the single source
   * of truth, and the legacy boolean is DERIVED from it at payload-build time
   * (see `jobFormToBasePayload`) so the two can never disagree.
   */
  requirements: RequirementsMap;
};

export const initialForm: JobForm = {
  title: '', location: '',
  city_key: null, city: null, state: null, state_region: '',
  latitude: null, longitude: null,
  job_type: 'full-time', description: '',
  pay_min: '', pay_max: '', pay_interval: 'hourly', start_date: '',
  expected_duration: '', shift_schedule: '', transportation_required: false,
  language_preference: ['any'],
  number_of_workers_needed: '1', trade_category: '', required_experience_years: '',
  certifications: '', requirements: initialRequirements(),
};

// Structural shape of the LocationPicker's onChange payload. Declared here
// rather than imported from '@/components/ui/LocationPicker' so lib/ keeps no
// dependency on components/; LocationPickerValue satisfies this type.
export type JobFormLocation = {
  label: string;
  cityKey: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
};

// Fold a LocationPicker selection into a JobForm. A free-typed value arrives
// with null ids/coordinates, which clears any previously picked city.
// state_region (the SEO display state) has no input of its own -- it derives
// from the picked city's USPS state; free-typed locations leave it blank and
// the backend parses it from the location text instead.
export function applyLocationToJobForm(form: JobForm, v: JobFormLocation): JobForm {
  return {
    ...form,
    location: v.label,
    city_key: v.cityKey,
    city: v.city,
    state: v.state,
    latitude: v.latitude,
    longitude: v.longitude,
    state_region: v.state ?? '',
  };
}

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

// A US state/territory postal abbreviation: exactly two letters. Empty is
// valid (the field is optional) -- callers decide whether empty is allowed
// for their step; this only rejects a non-empty value that isn't 2 letters.
const STATE_REGION_PATTERN = /^[A-Za-z]{2}$/;

export function validateJobLocationFields(form: JobForm): 'state_region' | null {
  const stateRegion = form.state_region.trim();
  if (stateRegion && !STATE_REGION_PATTERN.test(stateRegion)) return 'state_region';
  return null;
}

type BasePayload = Omit<JobWritePayload, 'city' | 'state_region'>;

function jobFormToBasePayload(form: JobForm): BasePayload {
  const { required_docs, optional_docs, required_fields, optional_fields } =
    requirementsToArrays(form.requirements);
  return {
    title: form.title.trim(),
    location: form.location.trim(),
    job_type: form.job_type,
    description: form.description.trim() || undefined,
    required_docs,
    optional_docs,
    required_fields,
    optional_fields,
    pay_min: parseOptionalNumber(form.pay_min),
    pay_max: parseOptionalNumber(form.pay_max),
    pay_interval: form.pay_interval,
    start_date: form.start_date || null,
    expected_duration: form.expected_duration.trim() || null,
    shift_schedule: form.shift_schedule.trim() || null,
    transportation_required: form.transportation_required,
    // Derived, not a separate input: the legacy standalone column mirrors
    // whichever tier `requirements.work_authorization` is actually set to,
    // so the two can never disagree (see `arraysToRequirements`'s migration
    // rule for the read-back direction).
    work_authorization_required: form.requirements.work_authorization === 'required',
    language_preference: form.language_preference,
    number_of_workers_needed: Number(form.number_of_workers_needed),
    trade_category: form.trade_category as string,
    required_experience_years: parseOptionalNumber(form.required_experience_years),
    certifications: splitDedupe(form.certifications),
    ...(form.city_key && form.city && form.state
      ? { city_key: form.city_key, city: form.city, state: form.state }
      : {}),
    ...(form.latitude != null && form.longitude != null
      ? { latitude: form.latitude, longitude: form.longitude }
      : {}),
  };
}

/**
 * CREATE path: there is no previously-stored state_region to protect, so a
 * blank field is OMITTED from the payload entirely (the key is absent,
 * `undefined`) rather than sent as an explicit `null`. That lets the
 * backend's resolveJobLocationFields fall back to auto-parsing the SEO
 * city/state_region out of the free-text `location` field -- which is what a
 * new job with a blank state_region input actually wants. Sending an
 * explicit `null` here (the old, buggy, single-function behavior) forced the
 * parsed location to be discarded on every create where the employer left
 * state_region blank.
 *
 * The city/state/city_key matching-identity triple is NOT this function's
 * concern -- it is folded in wholesale (or omitted wholesale) by
 * jobFormToBasePayload above, via the LocationPicker/applyLocationToJobForm
 * path. This frontend has no separate free-text SEO city input.
 */
export function jobFormToCreatePayload(form: JobForm): JobWritePayload {
  const stateTrimmed = form.state_region.trim().toUpperCase();
  return {
    ...jobFormToBasePayload(form),
    state_region: stateTrimmed || undefined,
  };
}

/**
 * EDIT path: the form is prefilled from the stored job (see jobToForm), so a
 * blank state_region is ambiguous unless we know what it started as:
 *   - started non-empty, now blank -> the employer deliberately cleared it:
 *     send an explicit `null` (resolveJobLocationFields' clear-override).
 *   - started empty, still blank -> never touched: OMIT the key so the
 *     backend's auto-parse from `location` still gets a chance to fill it in,
 *     the same as create.
 *   - non-blank current value -> send it, same as create.
 * `initial` is the state_region the form was prefilled with (typically the
 * loaded job, or the initial JobForm snapshot taken before edits began).
 * See jobFormToCreatePayload above re: the city/state/city_key triple, which
 * this function also does not touch directly.
 */
export function jobFormToEditPayload(
  form: JobForm,
  initial: Pick<JobForm, 'state_region'>,
): JobWritePayload {
  const stateTrimmed = form.state_region.trim().toUpperCase();
  const initialStateHadValue = initial.state_region.trim().length > 0;
  return {
    ...jobFormToBasePayload(form),
    state_region: stateTrimmed || (initialStateHadValue ? null : undefined),
  };
}

// Prefill a JobForm from a loaded job (edit mode).
export function jobToForm(job: EmployerJobDetail): JobForm {
  return {
    title: job.title ?? '',
    location: job.location ?? '',
    city_key: job.city_key ?? null,
    city: job.city ?? null,
    state: job.state ?? null,
    state_region: job.state_region ?? '',
    latitude: job.latitude != null ? Number(job.latitude) : null,
    longitude: job.longitude != null ? Number(job.longitude) : null,
    job_type: job.job_type,
    description: job.description ?? '',
    pay_min: job.pay_min != null ? String(job.pay_min) : '',
    pay_max: job.pay_max != null ? String(job.pay_max) : '',
    pay_interval: (job.pay_interval as PayInterval) || 'hourly',
    start_date: job.start_date ? job.start_date.slice(0, 10) : '',
    expected_duration: job.expected_duration ?? '',
    shift_schedule: job.shift_schedule ?? '',
    transportation_required: job.transportation_required ?? false,
    language_preference: (job.language_preference?.length ? job.language_preference : ['any']) as JobForm['language_preference'],
    number_of_workers_needed: String(job.number_of_workers_needed ?? 1),
    trade_category: (job.trade_category as JobForm['trade_category']) ?? '',
    required_experience_years: job.required_experience_years != null ? String(job.required_experience_years) : '',
    certifications: (job.certifications ?? []).join(', '),
    // `?? []` on all four -- a job/template payload from before this feature
    // (or the current, not-yet-updated backend handlers) carries none of
    // them, and every key must still resolve to 'off' rather than crash.
    requirements: arraysToRequirements({
      required_docs: job.required_docs ?? [],
      optional_docs: job.optional_docs ?? [],
      required_fields: job.required_fields ?? [],
      optional_fields: job.optional_fields ?? [],
      work_authorization_required: job.work_authorization_required ?? false,
    }),
  };
}

// Prefill a JobForm from a saved template payload. Delegates to jobToForm
// (the payload is the create-request shape, a subset-compatible cousin of
// EmployerJobDetail) and then blanks start_date -- templates never carry a
// date. cityPrefilled drives the "check the city" highlight in the modal.
export function jobFormFromTemplatePayload(
  payload: Partial<JobWritePayload>,
): { form: JobForm; cityPrefilled: boolean } {
  const form = jobToForm(payload as unknown as EmployerJobDetail);
  return {
    form: { ...form, start_date: '' },
    cityPrefilled: form.city_key !== null,
  };
}

// Row summary for the Templates page: human-glanceable city/trade/pay pulled
// from a stored template payload. Pure and defensive -- payloads are
// forward-compatible JSON, so every field may be missing. The pay string is
// currency-only; the page appends the localized interval label itself.
export function templateRowSummary(
  payload: Partial<JobWritePayload>,
  /** Localized interval label ("per hour" etc.); joined onto the pay string
   * here so ALL row derivation stays in this tested helper. */
  intervalLabel?: string,
): { city: string; trade: string; pay: string } {
  const EM_DASH = '—';
  const locationCity = payload.location?.includes(',')
    ? payload.location.split(',')[0].trim()
    : '';
  const city = payload.city || locationCity || EM_DASH;
  const trade = payload.trade_category || EM_DASH;
  const min = payload.pay_min ?? null;
  const max = payload.pay_max ?? null;
  let pay = EM_DASH;
  if (min !== null && max !== null) pay = `$${min}–$${max}`;
  else if (min !== null) pay = `$${min}+`;
  // "≤" rather than words: every pay variant must read correctly in both
  // locales without threading another label through here.
  else if (max !== null) pay = `≤ $${max}`;
  if (pay !== EM_DASH && intervalLabel) pay = `${pay} · ${intervalLabel}`;
  return { city, trade, pay };
}
