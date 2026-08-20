import { splitDedupe } from '@/lib/text';
import type { EmployerJobDetail, JobWritePayload } from '@/lib/api/employer';
import { locationDatasetFailed } from '@/lib/location-search';
import {
  type RequirementsMap,
  type RequirementState,
  type CertificationRequirement,
  type CertificationTier,
  initialRequirements,
  requirementsToArrays,
  arraysToRequirements,
} from '@/lib/job-requirements';
export type { RequirementsMap } from '@/lib/job-requirements';
export type { CertificationRequirement, CertificationTier } from '@/lib/job-requirements';
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

// Job-flow redesign (FE-T3): six new structured fields (migration
// 077_jobs_structured_fields.sql). DURATION_BUCKETS and WORK_DAYS byte-match
// that migration's `jobs_expected_duration_bucket_valid` / `jobs_work_days_valid`
// CHECK constraints -- the backend's own `infra/lambda/lib/job-fields.ts` does
// not yet declare these as TS constants (a later backend task must keep them
// in sync the same way TRADE_CATEGORIES/DOC_TYPES already are there).
export const DURATION_BUCKETS = ['lt_1w', '1_2w', '2_4w', '1_3m', '3_6m', '6m_plus', 'ongoing'] as const;
export type DurationBucket = typeof DURATION_BUCKETS[number];

export const WORK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WorkDay = typeof WORK_DAYS[number];

/**
 * English-canonical display strings for `deriveLegacyExpectedDuration` below.
 * Copied verbatim from `messages/en.json`'s `common.duration_bucket.*` (the
 * catalogue `lib/job-detail-display.ts`'s `durationLabel()` renders the
 * structured bucket through) -- NOT re-typed independently -- so the legacy
 * free-text fallback this module writes at save time reads identically to
 * the localized label the same job renders through elsewhere. This module
 * has no `next-intl` access (see file header precedent: existing
 * expected_duration/shift_schedule round-trips are already untranslated
 * English), so this is a plain object, not a translation catalogue.
 */
export const DURATION_BUCKET_LABELS: Record<DurationBucket, string> = {
  lt_1w: 'Less than 1 week',
  '1_2w': '1–2 weeks',
  '2_4w': '2–4 weeks',
  '1_3m': '1–3 months',
  '3_6m': '3–6 months',
  '6m_plus': '6+ months',
  ongoing: 'Ongoing / Permanent',
};

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
  /** Free text, only meaningful (and only ever sent) when trade_category === 'other'. */
  trade_category_other: string;
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
  /**
   * Closed-enum companion to the free-text `expected_duration` above (see
   * DURATION_BUCKETS). The two columns coexist server-side (migration 077);
   * `jobFormToBasePayload` derives `expected_duration` from this bucket only
   * when it is non-empty, otherwise the free-text field is passed through
   * untouched -- see that function's doc comment.
   */
  expected_duration_bucket: '' | DurationBucket;
  /** Structured schedule companion to the free-text `shift_schedule` above. */
  work_days: string[];
  /** 'HH:MM' 24h, or '' when not set. May be one-sided (see migration 077). */
  shift_start: string;
  shift_end: string;
  /**
   * Per-certification requirement rows (job-flow redesign, FE-T2 type, FE-T3
   * form/payload wiring). Independent of the legacy `certification_doc`
   * three-state row in `requirements` -- see `jobFormToBasePayload`, which
   * forces `certification_doc` off whenever this is non-empty.
   */
  certification_requirements: CertificationRequirement[];
};

export const initialForm: JobForm = {
  title: '', location: '',
  city_key: null, city: null, state: null, state_region: '',
  latitude: null, longitude: null,
  job_type: 'full-time', description: '',
  pay_min: '', pay_max: '', pay_interval: 'hourly', start_date: '',
  expected_duration: '', shift_schedule: '', transportation_required: false,
  language_preference: ['any'],
  number_of_workers_needed: '1', trade_category: '', trade_category_other: '', required_experience_years: '',
  certifications: '', requirements: initialRequirements(),
  expected_duration_bucket: '', work_days: [], shift_start: '', shift_end: '',
  certification_requirements: [],
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

/**
 * Whether `min` > `max`, treating either side blank as "no conflict yet" --
 * used both by `validateJobNumbers` below and standalone by a live inline
 * pay-range error while the employer is still typing (min===max is fine; an
 * empty side never counts as an out-of-range pair; non-numeric input is not
 * this function's concern, `validateJobNumbers`'s own 'number' check owns
 * that).
 */
export function payRangeExceeds(min: string, max: string): boolean {
  const parsedMin = parseOptionalNumber(min);
  const parsedMax = parseOptionalNumber(max);
  if (parsedMin === null || parsedMax === null || Number.isNaN(parsedMin) || Number.isNaN(parsedMax)) return false;
  return parsedMin > parsedMax;
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
  if (payRangeExceeds(form.pay_min, form.pay_max)) return 'pay_range';
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

// ---------------------------------------------------------------------------
// Consolidated step/full-form validation (FE-T3). Replaces the three
// near-identical inline blocks that used to live in
// PostJobModal.validateCurrentStep (step 1 / step 2), EditJobModal.handleSubmit,
// and TemplateEditModal.handleSubmit -- see those components' git history.
// Every return code maps 1:1 onto an existing `employer_dashboard.modal.*`
// i18n key; no new keys were added for this task.
// ---------------------------------------------------------------------------

export type StepBasicsErrorCode =
  | 'required'                        // modal.validation_required
  | 'trade_category_other_required'   // no dedicated key yet -- Wave-3 may map
                                       // this onto modal.validation_required
                                       // until a specific one is added.
  | 'location_pick_required'          // modal.location_pick_required
  | 'state_region';                   // modal.validation_state_region

/**
 * Step-1-equivalent checks: title/location/trade_category required, the new
 * trade_category_other requiredness rule (only when trade_category==='other'),
 * a picked city (unless the location dataset itself failed to load, in which
 * case the form falls back to accepting free text -- see `locationDatasetFailed`),
 * and state_region's format.
 */
export function validateStepBasics(form: JobForm): StepBasicsErrorCode | null {
  if (!form.title.trim() || !form.location.trim() || !form.trade_category) return 'required';
  if (form.trade_category === 'other' && !form.trade_category_other.trim()) return 'trade_category_other_required';
  if (!form.city_key && !locationDatasetFailed()) return 'location_pick_required';
  if (validateJobLocationFields(form) === 'state_region') return 'state_region';
  return null;
}

/**
 * Step-2-equivalent checks: the numeric fields (`validateJobNumbers`), the
 * new shift-time both-or-neither rule, and an optional edit-mode floor on
 * `number_of_workers_needed` (EditJobModal's `Number(form.number_of_workers_needed)
 * < job.hired_count` guard -- pass `{ minWorkers: job.hired_count }`; note
 * `job.hired_count || 1` and `job.hired_count` are behaviorally identical
 * here since `validateJobNumbers` already rejects < 1 on its own).
 *
 * shift_start/shift_end both-or-neither: migration 077 deliberately allows
 * either TIME column alone at the DB layer (a one-sided shift is a
 * legitimate shape), but the merged display formatter (`scheduleSummary` in
 * `lib/job-detail-display.ts`) only renders an hours range when BOTH bounds
 * are present, and suppresses the legacy `shift_schedule` fallback the
 * moment ANY structured schedule field is set. A one-sided submission from
 * this form would therefore render as no schedule row at all on the
 * public/worker pages, so it is blocked here at the form layer.
 * `deriveLegacyShiftSchedule`'s graceful one-bound handling stays in place
 * regardless, as defense-in-depth for data that arrives from elsewhere
 * (legacy rows, imports, a future API caller). Returns the distinct code
 * `'shift_incomplete'` (NOT the generic `'required'` -- that code already
 * means "title/location/trade_category" over in `validateStepBasics`, and a
 * caller flattening `validateFullJobForm`'s result must be able to tell the
 * two apart to know which control to highlight) which, for now, maps onto
 * the same `modal.validation_required` i18n key as `'required'` -- there is
 * no dedicated key for this shape yet.
 */
export function validateStepDetails(
  form: JobForm,
  opts?: { minWorkers?: number },
): 'number' | 'pay_range' | 'headcount' | 'shift_incomplete' | null {
  const code = validateJobNumbers(form);
  if (code) return code;
  if ((form.shift_start !== '') !== (form.shift_end !== '')) return 'shift_incomplete';
  if (opts?.minWorkers != null && Number(form.number_of_workers_needed) < opts.minWorkers) return 'headcount';
  return null;
}

/** validateStepBasics, then validateStepDetails -- basics errors take priority. */
export function validateFullJobForm(
  form: JobForm,
  opts?: { minWorkers?: number },
): StepBasicsErrorCode | 'number' | 'pay_range' | 'headcount' | 'shift_incomplete' | null {
  return validateStepBasics(form) ?? validateStepDetails(form, opts);
}

// ---------------------------------------------------------------------------
// Legacy free-text derivation (FE-T3). English-canonical -- this module has
// no next-intl access (existing expected_duration/shift_schedule round-trips
// are already untranslated English; see DURATION_BUCKET_LABELS above).
// Exported for reuse by the description-payload generation task.
// ---------------------------------------------------------------------------

export function deriveLegacyExpectedDuration(bucket: DurationBucket): string {
  return DURATION_BUCKET_LABELS[bucket];
}

/** Canonical Mon..Sun short labels, matching messages/en.json's common.work_days.*. */
const DAY_LABELS: Record<WorkDay, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/**
 * Groups the given days into consecutive runs along the FIXED Mon..Sun
 * sequence (never Sun->Mon) and joins them as "Mon–Tue, Thu–Fri". A run of
 * one day renders bare ("Wed"); the fixed, non-circular order is what makes
 * {sat,sun,mon} render as "Mon, Sat–Sun" rather than wrapping "Sat–Mon"
 * across the week boundary. Input order never matters. Returns '' for no days.
 */
function formatDayRanges(workDays: readonly string[]): string {
  const present = new Set(workDays);
  const ordered = WORK_DAYS.filter((day) => present.has(day));
  if (ordered.length === 0) return '';

  const runs: WorkDay[][] = [];
  for (const day of ordered) {
    const current = runs[runs.length - 1];
    const prevDay = current?.[current.length - 1];
    if (current && prevDay && WORK_DAYS.indexOf(prevDay) + 1 === WORK_DAYS.indexOf(day)) {
      current.push(day);
    } else {
      runs.push([day]);
    }
  }

  return runs
    .map((run) => run.length === 1 ? DAY_LABELS[run[0]] : `${DAY_LABELS[run[0]]}–${DAY_LABELS[run[run.length - 1]]}`)
    .join(', ');
}

/**
 * `'07:00'` (optionally with `:SS[.ffffff]`, tolerating a Postgres TIME
 * column's wire shape same as `job-detail-display.ts`'s `timeToUtcDate`) ->
 * `{ hour, minute }`, or `null` if unparseable/out of range.
 */
function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** `'07:00'` -> `'7:00 AM'`; `'16:00'` -> `'4:00 PM'`. `null` if unparseable. */
function formatTime12h(value: string): string | null {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return null;
  const period = parsed.hour >= 12 ? 'PM' : 'AM';
  const hour12 = parsed.hour % 12 || 12;
  return `${hour12}:${String(parsed.minute).padStart(2, '0')} ${period}`;
}

/**
 * Formats the shift-hours segment. Both bounds present -> "7:00 AM–4:00 PM"
 * (en dash, no spaces). One-sided shifts are a legitimate shape (migration
 * 077's header: "starts around 7am, end time varies") -- the convention
 * mirrors `formatPayRange()` in `infra/lambda/lib/job-fields.ts`, which
 * renders a one-sided pay bound as "From $20" / "Up to $30" rather than a
 * dangling dash. Returns '' when neither bound parses.
 */
function formatHoursRange(shiftStart: string, shiftEnd: string): string {
  const start = shiftStart.trim() ? formatTime12h(shiftStart) : null;
  const end = shiftEnd.trim() ? formatTime12h(shiftEnd) : null;
  if (start && end) return `${start}–${end}`;
  if (start) return `From ${start}`;
  if (end) return `Up to ${end}`;
  return '';
}

/**
 * Legacy `shift_schedule` free-text derivation from the structured
 * work_days/shift_start/shift_end fields, e.g.
 * "Mon–Tue, Thu–Fri · 7:00 AM–4:00 PM" (days-only and hours-only shapes omit
 * the missing segment and its separator entirely; '' when nothing is set).
 */
export function deriveLegacyShiftSchedule(workDays: readonly string[], shiftStart: string, shiftEnd: string): string {
  const daysPart = formatDayRanges(workDays);
  const hoursPart = formatHoursRange(shiftStart, shiftEnd);
  if (daysPart && hoursPart) return `${daysPart} · ${hoursPart}`;
  return daysPart || hoursPart;
}

type BasePayload = Omit<JobWritePayload, 'city' | 'state_region'>;

function jobFormToBasePayload(form: JobForm): BasePayload {
  const { required_docs, optional_docs, required_fields, optional_fields } =
    requirementsToArrays(form.requirements);

  // Trim/drop-blank once, up front, so `certifications` and
  // `certification_requirements[].name` can never disagree (job-fields.ts's
  // parseJobFields would 400 `invalid_certifications` on a blank entry).
  const trimmedCerts = form.certification_requirements
    .map((cert) => ({ ...cert, name: cert.name.trim() }))
    .filter((cert) => cert.name.length > 0);
  const hasCertRequirements = trimmedCerts.length > 0;

  // Per-cert requirements fully replace the legacy `certification_doc`
  // three-state row's job: the backend rejects the two riding together
  // (`invalid_certification_requirements_doc_conflict`), so `certification_doc`
  // is force-stripped from BOTH doc arrays whenever certs are present,
  // regardless of whatever tier the picker's `requirements` map still holds
  // for it. `deriveCertificationDocTier` (job-requirements.ts) is
  // display-only and must never be consulted here.
  const finalRequiredDocs = hasCertRequirements
    ? required_docs.filter((doc) => doc !== 'certification_doc')
    : required_docs;
  const finalOptionalDocs = hasCertRequirements
    ? optional_docs.filter((doc) => doc !== 'certification_doc')
    : optional_docs;

  const hasShiftStructure = form.work_days.length > 0 || form.shift_start !== '' || form.shift_end !== '';

  return {
    title: form.title.trim(),
    location: form.location.trim(),
    job_type: form.job_type,
    description: form.description.trim() || undefined,
    required_docs: finalRequiredDocs,
    optional_docs: finalOptionalDocs,
    required_fields,
    optional_fields,
    pay_min: parseOptionalNumber(form.pay_min),
    pay_max: parseOptionalNumber(form.pay_max),
    pay_interval: form.pay_interval,
    start_date: form.start_date || null,
    // Derive from the structured bucket ONLY when it is set; otherwise pass
    // the loaded legacy free-text value through untouched (unchanged
    // pre-FE-T3 behavior: trimmed, or explicit `null` when blank -- not
    // omitted, unlike the six new fields below).
    expected_duration: form.expected_duration_bucket
      ? deriveLegacyExpectedDuration(form.expected_duration_bucket)
      : (form.expected_duration.trim() || null),
    shift_schedule: hasShiftStructure
      ? deriveLegacyShiftSchedule(form.work_days, form.shift_start, form.shift_end)
      : (form.shift_schedule.trim() || null),
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
    certifications: hasCertRequirements
      ? trimmedCerts.map((cert) => cert.name)
      : splitDedupe(form.certifications),
    ...(form.city_key && form.city && form.state
      ? { city_key: form.city_key, city: form.city, state: form.state }
      : {}),
    ...(form.latitude != null && form.longitude != null
      ? { latitude: form.latitude, longitude: form.longitude }
      : {}),
    // The six FE-T3 structured fields: each independently OMITTED (key
    // absent, never explicit `null`) when empty, same all-or-nothing-per-field
    // precedent as latitude/longitude above -- there is no edit-mode "clear
    // override" story for these yet (unlike state_region's two-payload-builder
    // split), so omitting is also how an employer currently un-sets one:
    // deliberately out of scope for this task, not an oversight.
    //
    // trade_category_other is additionally gated on trade_category==='other':
    // migration 077's `jobs_trade_category_other_valid` CHECK is one-way
    // (`trade_category = 'other' OR trade_category_other IS NULL`), so stale
    // text left over from a prior 'other' selection must never ride along
    // once a different trade is picked -- sending it would build a payload
    // the database itself rejects.
    ...(form.trade_category === 'other' && form.trade_category_other.trim()
      ? { trade_category_other: form.trade_category_other.trim() }
      : {}),
    ...(form.expected_duration_bucket ? { expected_duration_bucket: form.expected_duration_bucket } : {}),
    // A fresh copy, not the form-state array reference -- every other field
    // in this builder hands over a fresh value (.trim()/.map()/splitDedupe),
    // and a stored template/job payload must not alias state a later form
    // edit could still mutate through (setForm always replaces the array,
    // but this keeps the builder's own no-aliasing contract regardless).
    ...(form.work_days.length > 0 ? { work_days: [...form.work_days] } : {}),
    ...(form.shift_start ? { shift_start: form.shift_start } : {}),
    ...(form.shift_end ? { shift_end: form.shift_end } : {}),
    ...(hasCertRequirements
      ? {
          certification_requirements: trimmedCerts.map((cert) => ({
            name: cert.name, tier: cert.tier, proof_required: cert.proof_required,
          })),
        }
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

/** `'07:00:00'` / `'07:00:30.5'` -> `'07:00'`; unparseable/absent -> `''`. */
function normalizeShiftTime(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{2}):(\d{2})/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : '';
}

function isDurationBucket(value: unknown): value is DurationBucket {
  return typeof value === 'string' && (DURATION_BUCKETS as readonly string[]).includes(value);
}

/**
 * The legacy `certification_doc` three-state row's tier, read from a job's
 * wire arrays. Named (and pointed) the OPPOSITE direction from
 * `deriveCertificationDocTier` in job-requirements.ts (certs -> implied doc
 * tier, display-only, never feeds a payload) -- this one is doc-arrays ->
 * tier, used ONLY to seed `certification_requirements` on first load of a
 * legacy job. Once `jobFormToBasePayload` round-trips a save, the per-cert
 * array is authoritative and this seeding never runs again for that job.
 */
function loadedCertDocTierFromArrays(job: {
  required_docs?: readonly string[] | null;
  optional_docs?: readonly string[] | null;
}): RequirementState {
  if ((job.required_docs ?? []).includes('certification_doc')) return 'required';
  if ((job.optional_docs ?? []).includes('certification_doc')) return 'optional';
  return 'off';
}

/**
 * `certification_requirements` for a loaded job. Non-empty stored per-cert
 * data wins outright (legacy fields are ignored entirely once this exists).
 * Otherwise, one-time migration seeding from the legacy shape: a legacy job
 * with free-text `certifications` names AND a non-Off `certification_doc`
 * tier gets one `{name, tier: <legacy tier>, proof_required: true}` row per
 * name (proof was implicitly required by uploading against that doc slot).
 * A legacy tier of 'off', or no legacy certification names at all, seeds
 * nothing.
 */
function seedCertificationRequirements(job: {
  certification_requirements?: readonly CertificationRequirement[] | null;
  certifications?: readonly string[] | null;
  required_docs?: readonly string[] | null;
  optional_docs?: readonly string[] | null;
}): CertificationRequirement[] {
  if (job.certification_requirements && job.certification_requirements.length > 0) {
    return job.certification_requirements.map((cert) => ({ ...cert }));
  }
  const names = job.certifications ?? [];
  if (names.length === 0) return [];
  const tier = loadedCertDocTierFromArrays(job);
  if (tier === 'off') return [];
  return names.map((name) => ({ name, tier: tier as CertificationTier, proof_required: true }));
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
    trade_category_other: job.trade_category_other ?? '',
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
    // FE-T3 additive fields (migration 077). Every one of these is absent on
    // a job row from before the migration, or from a client that hasn't been
    // updated to request the new columns -- `?? ''`/`?? []` throughout, plus
    // an allowlist filter on the enum-shaped ones, so a stale/unrecognized
    // value degrades to "not set" instead of crashing the form.
    expected_duration_bucket: isDurationBucket(job.expected_duration_bucket) ? job.expected_duration_bucket : '',
    work_days: (job.work_days ?? []).filter((day): day is WorkDay => (WORK_DAYS as readonly string[]).includes(day)),
    shift_start: normalizeShiftTime(job.shift_start),
    shift_end: normalizeShiftTime(job.shift_end),
    certification_requirements: seedCertificationRequirements(job),
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
