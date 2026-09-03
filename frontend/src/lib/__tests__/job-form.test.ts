import { describe, it, expect } from 'vitest';
import {
  applyLocationToJobForm, initialForm, jobFormToCreatePayload, jobFormToEditPayload, jobToForm, validateJobLocationFields, jobFormFromTemplatePayload, templateRowSummary, setRequirementState, type JobForm,
  DURATION_BUCKETS, WORK_DAYS, DURATION_BUCKET_LABELS, type DurationBucket,
  deriveLegacyExpectedDuration, deriveLegacyShiftSchedule,
  payRangeExceeds, validateJobNumbers, validateStepBasics, validateStepDetails, validateFullJobForm,
  validateStepRequirements,
  type CertificationRequirement,
} from '@/lib/job-form';
import type { EmployerJobDetail } from '@/lib/api/employer';

const base: JobForm = { ...initialForm, title: 'Roofer', location: 'El Paso, TX', trade_category: 'other' };

const baseJob: EmployerJobDetail = {
  id: 'job-1',
  title: 'Roofer',
  location: 'El Paso, TX',
  city_key: 'el-paso-tx',
  city: 'El Paso',
  state: 'TX',
  latitude: 31.76,
  longitude: -106.49,
  pay: null,
  job_type: 'full-time',
  status: 'active',
  applicant_count: 0,
  hired_count: 0,
  open_count: 0,
  pay_min: null,
  pay_max: null,
  pay_interval: null,
  start_date: null,
  expected_duration: null,
  shift_schedule: null,
  transportation_required: false,
  work_authorization_required: false,
  language_preference: ['any'],
  number_of_workers_needed: 1,
  trade_category: 'other',
  required_experience_years: null,
  required_experience_months: null,
  certifications: [],
  created_at: '2026-01-01T00:00:00Z',
  description: null,
  required_docs: [],
  public_code: 'abc123',
  public_listing_enabled: false,
};

describe('jobFormToCreatePayload city + coordinates', () => {
  it('includes the city triple and coordinates when picked', () => {
    const payload = jobFormToCreatePayload({
      ...base,
      city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
      latitude: 31.76, longitude: -106.49,
    });
    expect(payload).toMatchObject({
      city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
      latitude: 31.76, longitude: -106.49,
    });
  });

  it('omits city and coordinates when not picked', () => {
    const payload = jobFormToCreatePayload(base);
    expect('city_key' in payload).toBe(false);
    expect('city' in payload).toBe(false);
    expect('state' in payload).toBe(false);
    expect('latitude' in payload).toBe(false);
    expect('longitude' in payload).toBe(false);
  });

  it('omits the whole city triple when it is only partially picked', () => {
    const payload = jobFormToCreatePayload({
      ...base,
      city_key: 'el-paso-tx', city: 'El Paso', state: null,
    });
    expect('city_key' in payload).toBe(false);
    expect('city' in payload).toBe(false);
    expect('state' in payload).toBe(false);
  });

  it('still sends coordinates when no city has been picked (gates are independent)', () => {
    const payload = jobFormToCreatePayload({
      ...base,
      latitude: 31.76, longitude: -106.49,
    });
    expect('city_key' in payload).toBe(false);
    expect(payload).toMatchObject({ latitude: 31.76, longitude: -106.49 });
  });

  it('sends latitude/longitude of 0 (a `!= null` gate, not truthiness)', () => {
    const payload = jobFormToCreatePayload({
      ...base,
      latitude: 0, longitude: 0,
    });
    expect(payload).toMatchObject({ latitude: 0, longitude: 0 });
  });
});

describe('applyLocationToJobForm', () => {
  it('fills the label, city triple and coordinates from a picked suggestion', () => {
    const next = applyLocationToJobForm(base, {
      label: 'El Paso, TX 79901',
      cityKey: 'el-paso-tx',
      city: 'El Paso',
      state: 'TX',
      latitude: 31.76,
      longitude: -106.49,
    });

    expect(next).toMatchObject({
      location: 'El Paso, TX 79901',
      city_key: 'el-paso-tx',
      city: 'El Paso',
      state: 'TX',
      latitude: 31.76,
      longitude: -106.49,
    });
    // Untouched fields survive the spread.
    expect(next.title).toBe('Roofer');
    expect(next.trade_category).toBe('other');
  });

  it('derives state_region from the picked state (no input of its own) and blanks it on free text', () => {
    const picked = applyLocationToJobForm(base, {
      label: 'El Paso, TX 79901',
      cityKey: 'el-paso-tx',
      city: 'El Paso',
      state: 'TX',
      latitude: 31.76,
      longitude: -106.49,
    });
    expect(picked.state_region).toBe('TX');

    const freeTyped = applyLocationToJobForm(picked, {
      label: 'somewhere near the border',
      cityKey: null,
      city: null,
      state: null,
      latitude: null,
      longitude: null,
    });
    // Blank -> the payload omits it and the backend parses the location text.
    expect(freeTyped.state_region).toBe('');
  });

  it('nulls a previously picked city when the user free-types over it', () => {
    const picked = applyLocationToJobForm(base, {
      label: 'El Paso, TX 79901',
      cityKey: 'el-paso-tx',
      city: 'El Paso',
      state: 'TX',
      latitude: 31.76,
      longitude: -106.49,
    });

    const typed = applyLocationToJobForm(picked, {
      label: 'El Pas',
      cityKey: null,
      city: null,
      state: null,
      latitude: null,
      longitude: null,
    });

    expect(typed.location).toBe('El Pas');
    expect(typed.city_key).toBeNull();
    expect(typed.city).toBeNull();
    expect(typed.state).toBeNull();
    expect(typed.latitude).toBeNull();
    expect(typed.longitude).toBeNull();
  });

  it('does not mutate the input form', () => {
    applyLocationToJobForm(base, {
      label: 'El Paso, TX 79901',
      cityKey: 'el-paso-tx',
      city: 'El Paso',
      state: 'TX',
      latitude: 31.76,
      longitude: -106.49,
    });

    expect(base.location).toBe('El Paso, TX');
    expect(base.city_key).toBeNull();
  });
});

describe('jobToForm city + coordinates prefill', () => {
  it('coalesces undefined city/coordinate fields to null', () => {
    const job = {
      ...baseJob,
      city_key: undefined,
      city: undefined,
      state: undefined,
      latitude: undefined,
      longitude: undefined,
    } as unknown as EmployerJobDetail;

    const form = jobToForm(job);

    expect(form.city_key).toBeNull();
    expect(form.city).toBeNull();
    expect(form.state).toBeNull();
    expect(form.latitude).toBeNull();
    expect(form.longitude).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// state_region -- independent SEO-region override (backend: resolveJobLocationFields)
//
// Note: origin/main's version of this file also tested `city` as a free-text
// string field (trim/uppercase/null-when-blank), independent of the
// city_key/city/state picker triple. That design isn't carried forward here:
// per the merge doctrine, `city` stays the nullable picker field above (see
// 'jobFormToCreatePayload city + coordinates' and 'applyLocationToJobForm'),
// and this frontend has no separate free-text SEO city input to exercise.
// jobFormToCreatePayload/jobFormToEditPayload don't touch `city` at all -- it
// travels solely via jobFormToBasePayload's all-or-none triple spread. Only
// state_region -- which IS a genuinely new, independent field -- is
// exercised below.
// ---------------------------------------------------------------------------

describe('jobFormToCreatePayload state_region', () => {
  it('create+blank: omits state_region entirely (undefined -> backend auto-parses location)', () => {
    const payload = jobFormToCreatePayload({
      ...initialForm,
      title: 'Job',
      location: 'Hayward, CA',
      trade_category: 'electrician',
    });
    // There is no previously-stored value to protect on create, so a blank
    // field must be OMITTED (key absent), not sent as an explicit `null` --
    // an explicit null would override the backend's auto-parse of `location`
    // and clear state_region on every create where the employer left the
    // field blank (the prod-live bug this fix addresses).
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('state_region');
    expect(payload.state_region).toBeUndefined();
    // Untouched by state_region: the city triple is still all-or-none omitted.
    expect('city' in payload).toBe(false);
  });

  it('create+filled: includes the uppercased state_region', () => {
    const payload = jobFormToCreatePayload({ ...initialForm, state_region: 'ca' });
    expect(payload.state_region).toBe('CA');
  });

  it('trims a whitespace-only state_region down to omitted, same as fully blank', () => {
    const payload = jobFormToCreatePayload({ ...initialForm, state_region: '   ' });
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('state_region');
  });
});

describe('jobFormToEditPayload state_region', () => {
  it('edit prefilled->blanked: sends an explicit null clear-override for a field that started non-empty', () => {
    const initial = { ...initialForm, state_region: 'TX' };
    const blanked = { ...initial, state_region: '' };
    const payload = jobFormToEditPayload(blanked, initial);
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('state_region', null);
  });

  it('edit blank->blank: omits the key when the field started empty and is still empty', () => {
    const initial = { ...initialForm, state_region: '' };
    const stillBlank = { ...initial };
    const payload = jobFormToEditPayload(stillBlank, initial);
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('state_region');
  });

  it('edit filled->filled: sends the new uppercased value regardless of the initial value', () => {
    const initial = { ...initialForm, state_region: 'TX' };
    const edited = { ...initial, state_region: 'ca' };
    const payload = jobFormToEditPayload(edited, initial);
    expect(payload.state_region).toBe('CA');
  });

  it('edit blank->filled: sends the new value even though the field started empty', () => {
    const initial = { ...initialForm, state_region: '' };
    const filled = { ...initial, state_region: 'ca' };
    const payload = jobFormToEditPayload(filled, initial);
    expect(payload.state_region).toBe('CA');
  });
});

describe('validateJobLocationFields', () => {
  it('allows an empty state_region (optional field)', () => {
    expect(validateJobLocationFields({ ...initialForm, state_region: '' })).toBeNull();
  });

  it('allows a valid 2-letter state_region regardless of case', () => {
    expect(validateJobLocationFields({ ...initialForm, state_region: 'ca' })).toBeNull();
    expect(validateJobLocationFields({ ...initialForm, state_region: 'TX' })).toBeNull();
  });

  it('rejects a state_region that mixes letters and digits', () => {
    expect(validateJobLocationFields({ ...initialForm, state_region: '1A' })).toBe('state_region');
  });

  it('rejects a state_region with the wrong length', () => {
    expect(validateJobLocationFields({ ...initialForm, state_region: 'CAL' })).toBe('state_region');
    expect(validateJobLocationFields({ ...initialForm, state_region: 'C' })).toBe('state_region');
  });
});

describe('jobFormFromTemplatePayload', () => {
  const payload = {
    title: 'Concrete Finisher', location: 'El Paso, TX', job_type: 'contract' as const,
    trade_category: 'concrete', pay_min: 20, pay_max: 28, pay_interval: 'hourly' as const,
    required_docs: ['resume'], city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
    latitude: 31.7619, longitude: -106.485,
  };

  it('maps a full payload onto the form and reports the prefilled city', () => {
    const { form, cityPrefilled } = jobFormFromTemplatePayload(payload);
    expect(form.title).toBe('Concrete Finisher');
    expect(form.pay_min).toBe('20');
    expect(form.requirements.resume).toBe('required');
    expect(form.requirements.driver_license).toBe('off');
    expect(form.city_key).toBe('el-paso-tx');
    expect(cityPrefilled).toBe(true);
  });

  it('never applies a start_date, even if an old template stored one', () => {
    const { form } = jobFormFromTemplatePayload({ ...payload, start_date: '2026-01-01' } as never);
    expect(form.start_date).toBe('');
  });

  it('defaults missing keys and reports no city for cityless payloads', () => {
    const { form, cityPrefilled } = jobFormFromTemplatePayload({
      title: 'x', location: 'somewhere', job_type: 'contract' as const,
    });
    expect(form.number_of_workers_needed).toBe('1');
    expect(form.language_preference).toEqual(['any']);
    expect(form.city_key).toBeNull();
    expect(cityPrefilled).toBe(false);
  });

  it('drops unknown keys instead of leaking them into the form', () => {
    const { form } = jobFormFromTemplatePayload({ ...payload, bogus_future_field: 'x' } as never);
    expect('bogus_future_field' in form).toBe(false);
  });
});

describe('requirements mapper round-trip (three-state -> four arrays -> back)', () => {
  it('jobFormToCreatePayload emits all four arrays split by doc vs field vocabulary', () => {
    const form: JobForm = {
      ...base,
      requirements: setRequirementState(
        setRequirementState(initialForm.requirements, 'resume', 'required'),
        'references', 'optional',
      ),
    };
    const payload = jobFormToCreatePayload(form);
    expect(payload.required_docs).toEqual(['resume']);
    expect(payload.optional_docs).toEqual([]);
    expect(payload.optional_fields).toEqual(['references']);
    expect(payload.required_fields).toEqual(
      expect.arrayContaining(['work_authorization', 'date_available', 'emergency_contact', 'worked_here_before']),
    );
  });

  it('jobToForm reconstructs the exact three-state map a create payload produced', () => {
    const form: JobForm = {
      ...base,
      requirements: setRequirementState(
        setRequirementState(initialForm.requirements, 'certification_doc', 'optional'),
        'education', 'required',
      ),
    };
    const payload = jobFormToCreatePayload(form);
    const job: EmployerJobDetail = {
      ...baseJob,
      required_docs: payload.required_docs ?? [],
      optional_docs: payload.optional_docs,
      required_fields: payload.required_fields,
      optional_fields: payload.optional_fields,
      work_authorization_required: payload.work_authorization_required ?? false,
    };
    const rebuilt = jobToForm(job);
    expect(rebuilt.requirements).toEqual(form.requirements);
  });

  it('derives work_authorization_required from the requirements map rather than a separate input', () => {
    const required = jobFormToCreatePayload({
      ...base,
      requirements: setRequirementState(initialForm.requirements, 'work_authorization', 'required'),
    });
    expect(required.work_authorization_required).toBe(true);

    const off = jobFormToCreatePayload({
      ...base,
      requirements: setRequirementState(initialForm.requirements, 'work_authorization', 'off'),
    });
    expect(off.work_authorization_required).toBe(false);

    const optional = jobFormToCreatePayload({
      ...base,
      requirements: setRequirementState(initialForm.requirements, 'work_authorization', 'optional'),
    });
    expect(optional.work_authorization_required).toBe(false);
  });

  it('jobToForm defaults every requirement to off for a legacy job with none of the four arrays', () => {
    const legacyJob = { ...baseJob } as EmployerJobDetail;
    delete (legacyJob as Record<string, unknown>).required_docs;
    const form = jobToForm({ ...legacyJob, required_docs: undefined as unknown as string[] });
    for (const state of Object.values(form.requirements)) expect(state).toBe('off');
  });

  it('work-auth migration rule: a legacy job with work_authorization_required=true but no required_fields entry loads as Required', () => {
    const legacyJob: EmployerJobDetail = {
      ...baseJob,
      work_authorization_required: true,
      required_fields: [],
    };
    const form = jobToForm(legacyJob);
    expect(form.requirements.work_authorization).toBe('required');
  });

  it('does not crash loading an old template payload missing all four requirement arrays', () => {
    const { form } = jobFormFromTemplatePayload({
      title: 'Old Template', location: 'Reno, NV', job_type: 'full-time' as const, trade_category: 'other',
    });
    for (const state of Object.values(form.requirements)) expect(state).toBe('off');
  });
});

describe('templateRowSummary', () => {
  it('summarizes a full payload', () => {
    expect(templateRowSummary({
      city: 'El Paso', trade_category: 'concrete',
      pay_min: 20, pay_max: 28, pay_interval: 'hourly',
      location: 'El Paso, TX 79901',
    })).toEqual({ city: 'El Paso', trade: 'concrete', pay: '$20–$28' });
  });

  it('falls back to the location text before the first comma when city is absent', () => {
    expect(templateRowSummary({ location: 'Las Cruces, NM' }).city).toBe('Las Cruces');
  });

  it('uses em dashes for missing values and a commaless location', () => {
    expect(templateRowSummary({ location: 'near the yard' }))
      .toEqual({ city: '—', trade: '—', pay: '—' });
    expect(templateRowSummary({})).toEqual({ city: '—', trade: '—', pay: '—' });
  });

  it('formats one-sided pay ranges without locale-bound words', () => {
    expect(templateRowSummary({ pay_min: 20 }).pay).toBe('$20+');
    expect(templateRowSummary({ pay_max: 30 }).pay).toBe('≤ $30');
  });

  it('joins a provided interval label onto real pay, never onto the em dash', () => {
    expect(templateRowSummary({ pay_min: 20, pay_max: 28 }, 'per hour').pay).toBe('$20–$28 · per hour');
    expect(templateRowSummary({}, 'per hour').pay).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// FE-T3: job-flow-redesign structured fields (trade_category_other,
// expected_duration_bucket, work_days, shift_start/shift_end,
// certification_requirements) -- constants, legacy derivation, jobToForm
// parsing/seeding, and the payload rules.
// ---------------------------------------------------------------------------

describe('DURATION_BUCKETS / WORK_DAYS constants', () => {
  it('byte-matches the migration 077 enum order', () => {
    expect(DURATION_BUCKETS).toEqual(['lt_1w', '1_2w', '2_4w', '1_3m', '3_6m', '6m_plus', 'ongoing']);
  });

  it('byte-matches the migration 077 work_days allowlist order', () => {
    expect(WORK_DAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

describe('initialForm additive defaults', () => {
  it('defaults every FE-T3 field to its empty shape', () => {
    expect(initialForm.trade_category_other).toBe('');
    expect(initialForm.expected_duration_bucket).toBe('');
    expect(initialForm.work_days).toEqual([]);
    expect(initialForm.shift_start).toBe('');
    expect(initialForm.shift_end).toBe('');
    expect(initialForm.certification_requirements).toEqual([]);
  });
});

describe('deriveLegacyExpectedDuration', () => {
  // Copied byte-for-byte from messages/en.json's common.duration_bucket.* --
  // job-detail-display.ts's durationLabel() renders the SAME job via that
  // catalogue, so the legacy free-text fallback this produces must read
  // identically, not merely "close enough".
  const EXPECTED: Record<DurationBucket, string> = {
    lt_1w: 'Less than 1 week',
    '1_2w': '1–2 weeks',
    '2_4w': '2–4 weeks',
    '1_3m': '1–3 months',
    '3_6m': '3–6 months',
    '6m_plus': '6+ months',
    ongoing: 'Ongoing / Permanent',
  };

  it('matches messages/en.json common.duration_bucket verbatim for every bucket', () => {
    for (const bucket of DURATION_BUCKETS) {
      expect(DURATION_BUCKET_LABELS[bucket]).toBe(EXPECTED[bucket]);
      expect(deriveLegacyExpectedDuration(bucket)).toBe(EXPECTED[bucket]);
    }
  });
});

describe('deriveLegacyShiftSchedule', () => {
  it('does not wrap the week: {sat,sun,mon} groups Sat-Sun together, Mon alone', () => {
    expect(deriveLegacyShiftSchedule(['sat', 'sun', 'mon'], '', '')).toBe('Mon, Sat–Sun');
  });

  it('groups two separate mid-week runs', () => {
    expect(deriveLegacyShiftSchedule(['mon', 'tue', 'thu', 'fri'], '', '')).toBe('Mon–Tue, Thu–Fri');
  });

  it('renders a single selected day with no dash', () => {
    expect(deriveLegacyShiftSchedule(['wed'], '', '')).toBe('Wed');
  });

  it('collapses a full week into one range', () => {
    expect(deriveLegacyShiftSchedule(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], '', '')).toBe('Mon–Sun');
  });

  it('is order-independent -- input order never affects the rendered grouping', () => {
    expect(deriveLegacyShiftSchedule(['fri', 'mon', 'thu', 'tue'], '', '')).toBe('Mon–Tue, Thu–Fri');
  });

  it('formats a full 12h hours range with no days present', () => {
    expect(deriveLegacyShiftSchedule([], '07:00', '16:00')).toBe('7:00 AM–4:00 PM');
  });

  it('combines days and hours with a middot separator', () => {
    expect(deriveLegacyShiftSchedule(['mon', 'tue', 'thu', 'fri'], '07:00', '16:00'))
      .toBe('Mon–Tue, Thu–Fri · 7:00 AM–4:00 PM');
  });

  // One-sided shifts are a legitimate shape (migration 077's header: "starts
  // around 7am, end time varies"). Convention mirrors formatPayRange() in
  // infra/lambda/lib/job-fields.ts, which renders a one-sided pay bound as
  // "From $20" / "Up to $30" rather than a dangling dash.
  it('renders a start-only shift as "From <time>"', () => {
    expect(deriveLegacyShiftSchedule([], '07:00', '')).toBe('From 7:00 AM');
  });

  it('renders an end-only shift as "Up to <time>"', () => {
    expect(deriveLegacyShiftSchedule([], '', '16:00')).toBe('Up to 4:00 PM');
  });

  it('handles midnight and noon boundaries (12-hour rollover)', () => {
    expect(deriveLegacyShiftSchedule([], '00:00', '12:00')).toBe('12:00 AM–12:00 PM');
  });

  it('tolerates a Postgres TIME value with seconds (HH:MM:SS)', () => {
    expect(deriveLegacyShiftSchedule([], '07:00:00', '16:00:30.5')).toBe('7:00 AM–4:00 PM');
  });

  it('returns an empty string when nothing is set', () => {
    expect(deriveLegacyShiftSchedule([], '', '')).toBe('');
  });

  it('ignores an unparseable time rather than crashing', () => {
    expect(deriveLegacyShiftSchedule([], 'garbage', '16:00')).toBe('Up to 4:00 PM');
  });
});

describe('payRangeExceeds', () => {
  it('is false when min equals max', () => {
    expect(payRangeExceeds('20', '20')).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(payRangeExceeds('', '30')).toBe(false);
    expect(payRangeExceeds('20', '')).toBe(false);
    expect(payRangeExceeds('', '')).toBe(false);
  });

  it('is true when min exceeds max', () => {
    expect(payRangeExceeds('30', '20')).toBe(true);
  });

  it('is false when min is below max', () => {
    expect(payRangeExceeds('20', '30')).toBe(false);
  });

  it('is false for non-numeric input (not this function\'s job to flag)', () => {
    expect(payRangeExceeds('abc', '20')).toBe(false);
  });
});

describe('validateJobNumbers (regression coverage for the payRangeExceeds refactor)', () => {
  it('accepts a fully valid form', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: '20', pay_max: '30', number_of_workers_needed: '2', required_experience_years: '1' })).toBeNull();
  });

  it('flags non-numeric pay as "number"', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: 'abc' })).toBe('number');
  });

  it('flags a negative pay value as "number"', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: '-5' })).toBe('number');
  });

  // Pins the payRangeExceeds refactor: a negative pay_max alongside a valid
  // pay_min must still hit the pre-existing "number" check (line order:
  // negative-value check runs BEFORE the pay_range/payRangeExceeds check),
  // not get reclassified as "pay_range" or silently pass.
  it('flags a valid pay_min with a negative pay_max as "number", not "pay_range"', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: '5', pay_max: '-1' })).toBe('number');
  });

  it('flags a negative pay_max alone as "number"', () => {
    expect(validateJobNumbers({ ...initialForm, pay_max: '-1' })).toBe('number');
  });

  it('flags min > max as "pay_range"', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: '30', pay_max: '20' })).toBe('pay_range');
  });

  it('allows min === max', () => {
    expect(validateJobNumbers({ ...initialForm, pay_min: '20', pay_max: '20' })).toBeNull();
  });

  it('flags fewer than 1 worker as "headcount"', () => {
    expect(validateJobNumbers({ ...initialForm, number_of_workers_needed: '0' })).toBe('headcount');
  });
});

describe('validateStepBasics', () => {
  const validBasics: JobForm = { ...initialForm, title: 'Roofer', location: 'El Paso, TX', trade_category: 'concrete', city_key: 'el-paso-tx' };

  it('passes a fully valid basics form', () => {
    expect(validateStepBasics(validBasics)).toBeNull();
  });

  it('flags a missing title as "required"', () => {
    expect(validateStepBasics({ ...validBasics, title: '' })).toBe('required');
  });

  it('flags a missing location as "required"', () => {
    expect(validateStepBasics({ ...validBasics, location: '' })).toBe('required');
  });

  it('flags a missing trade_category as "required"', () => {
    expect(validateStepBasics({ ...validBasics, trade_category: '' })).toBe('required');
  });

  it('requires trade_category_other when trade_category is "other"', () => {
    expect(validateStepBasics({ ...validBasics, trade_category: 'other', trade_category_other: '' }))
      .toBe('trade_category_other_required');
  });

  it('accepts trade_category "other" once trade_category_other is filled', () => {
    expect(validateStepBasics({ ...validBasics, trade_category: 'other', trade_category_other: 'Welder' }))
      .toBeNull();
  });

  it('does not require trade_category_other for a non-"other" trade', () => {
    expect(validateStepBasics({ ...validBasics, trade_category: 'concrete', trade_category_other: '' }))
      .toBeNull();
  });

  it('requires a picked city (location_pick_required)', () => {
    expect(validateStepBasics({ ...validBasics, city_key: null })).toBe('location_pick_required');
  });

  it('flags a malformed state_region once a city is picked', () => {
    // city_key must be set here, or the location_pick_required branch above
    // fires first and masks this check.
    expect(validateStepBasics({ ...validBasics, state_region: '1A' })).toBe('state_region');
  });

  it('priority: the bundled required-fields check wins over trade_category_other', () => {
    expect(validateStepBasics({ ...validBasics, title: '', trade_category: 'other', trade_category_other: '' }))
      .toBe('required');
  });

  it('priority: trade_category_other wins over the city-pick check', () => {
    expect(validateStepBasics({ ...validBasics, trade_category: 'other', trade_category_other: '', city_key: null }))
      .toBe('trade_category_other_required');
  });
});

describe('validateStepDetails', () => {
  it('passes valid numbers with no minWorkers constraint', () => {
    expect(validateStepDetails({ ...initialForm, number_of_workers_needed: '2' })).toBeNull();
  });

  it('passes through validateJobNumbers codes unchanged', () => {
    expect(validateStepDetails({ ...initialForm, pay_min: 'abc' })).toBe('number');
    expect(validateStepDetails({ ...initialForm, pay_min: '30', pay_max: '20' })).toBe('pay_range');
    expect(validateStepDetails({ ...initialForm, number_of_workers_needed: '0' })).toBe('headcount');
  });

  it('flags headcount below an edit-mode minWorkers floor (EditJobModal\'s hired_count guard)', () => {
    expect(validateStepDetails({ ...initialForm, number_of_workers_needed: '2' }, { minWorkers: 3 })).toBe('headcount');
  });

  it('allows headcount exactly at the minWorkers floor', () => {
    expect(validateStepDetails({ ...initialForm, number_of_workers_needed: '3' }, { minWorkers: 3 })).toBeNull();
  });

  it('base numeric validation still wins over a satisfied minWorkers floor', () => {
    expect(validateStepDetails({ ...initialForm, pay_min: '30', pay_max: '20', number_of_workers_needed: '5' }, { minWorkers: 3 }))
      .toBe('pay_range');
  });

  // Both-or-neither for shift_start/shift_end: migration 077 allows either
  // TIME column alone at the DB layer, but lib/job-detail-display.ts's
  // scheduleSummary() only renders an hours range when BOTH bounds are
  // present AND suppresses the legacy shift_schedule fallback the moment any
  // structured field exists -- so a one-sided submission from this form
  // would display as no schedule row at all. Blocked here at the form layer.
  // Distinct code from validateStepBasics's 'required' (title/location/trade)
  // so a caller flattening validateFullJobForm's result can still tell which
  // control to highlight; both currently map onto the same
  // `modal.validation_required` i18n key (no dedicated key exists yet).
  it('flags a start-only shift as "shift_incomplete"', () => {
    expect(validateStepDetails({ ...initialForm, shift_start: '07:00' })).toBe('shift_incomplete');
  });

  it('flags an end-only shift as "shift_incomplete"', () => {
    expect(validateStepDetails({ ...initialForm, shift_end: '16:00' })).toBe('shift_incomplete');
  });

  it('allows both shift bounds set', () => {
    expect(validateStepDetails({ ...initialForm, shift_start: '07:00', shift_end: '16:00' })).toBeNull();
  });

  it('allows neither shift bound set', () => {
    expect(validateStepDetails({ ...initialForm, shift_start: '', shift_end: '' })).toBeNull();
  });

  it('a days-only schedule (no shift hours) remains valid', () => {
    expect(validateStepDetails({ ...initialForm, work_days: ['mon', 'tue'] })).toBeNull();
  });
});

describe('validateFullJobForm', () => {
  const validForm: JobForm = { ...initialForm, title: 'Roofer', location: 'El Paso, TX', trade_category: 'concrete', city_key: 'el-paso-tx' };

  it('passes a fully valid form', () => {
    expect(validateFullJobForm(validForm)).toBeNull();
  });

  it('basics errors take priority over details errors', () => {
    expect(validateFullJobForm({ ...validForm, title: '', pay_min: '30', pay_max: '20' })).toBe('required');
  });

  it('falls through to a details error once basics pass', () => {
    expect(validateFullJobForm({ ...validForm, pay_min: '30', pay_max: '20' })).toBe('pay_range');
  });

  it('forwards the minWorkers option to the details stage', () => {
    expect(validateFullJobForm({ ...validForm, number_of_workers_needed: '2' }, { minWorkers: 3 })).toBe('headcount');
  });
});

describe('jobFormToBasePayload (via jobFormToCreatePayload): trade_category_other', () => {
  const base: JobForm = { ...initialForm, title: 'Job', location: 'Reno, NV', trade_category: 'other', trade_category_other: 'Welder' };

  it('includes the trimmed trade_category_other when trade_category is "other"', () => {
    expect(jobFormToCreatePayload({ ...base, trade_category_other: '  Welder  ' }).trade_category_other).toBe('Welder');
  });

  it('omits trade_category_other when it is blank', () => {
    const payload = jobFormToCreatePayload({ ...base, trade_category_other: '' });
    expect('trade_category_other' in payload).toBe(false);
  });

  // Migration 077's jobs_trade_category_other_valid CHECK is one-way:
  // `trade_category = 'other' OR trade_category_other IS NULL`. A stale
  // trade_category_other left over from a prior "other" selection must never
  // ride along once the employer picks a different trade -- sending it would
  // build a payload the database itself would reject.
  it('omits trade_category_other when trade_category is not "other", even if the field still holds stale text', () => {
    const payload = jobFormToCreatePayload({ ...base, trade_category: 'electrician', trade_category_other: 'Welder' });
    expect('trade_category_other' in payload).toBe(false);
  });
});

describe('jobFormToBasePayload (via jobFormToCreatePayload): expected_duration_bucket', () => {
  const base: JobForm = { ...initialForm, title: 'Job', location: 'Reno, NV', trade_category: 'concrete' };

  it('derives expected_duration from the bucket and includes the raw bucket', () => {
    const payload = jobFormToCreatePayload({ ...base, expected_duration_bucket: '2_4w' });
    expect(payload.expected_duration).toBe('2–4 weeks');
    expect(payload.expected_duration_bucket).toBe('2_4w');
  });

  it('passes the legacy free-text value through untouched when the bucket is empty', () => {
    const payload = jobFormToCreatePayload({ ...base, expected_duration: 'Two-ish weeks' });
    expect(payload.expected_duration).toBe('Two-ish weeks');
    expect('expected_duration_bucket' in payload).toBe(false);
  });

  it('sends null expected_duration (not omitted) when both the bucket and the legacy text are blank', () => {
    const payload = jobFormToCreatePayload(base);
    expect(payload.expected_duration).toBeNull();
    expect('expected_duration_bucket' in payload).toBe(false);
  });
});

describe('jobFormToBasePayload (via jobFormToCreatePayload): work_days / shift_start / shift_end', () => {
  const base: JobForm = { ...initialForm, title: 'Job', location: 'Reno, NV', trade_category: 'concrete' };

  it('derives shift_schedule from work_days alone and includes the raw array', () => {
    const workDays = ['mon', 'tue'];
    const payload = jobFormToCreatePayload({ ...base, work_days: workDays });
    expect(payload.shift_schedule).toBe('Mon–Tue');
    expect(payload.work_days).toEqual(['mon', 'tue']);
    // A fresh copy, not the same form-state array reference (no-aliasing
    // contract shared with every other field this builder derives).
    expect(payload.work_days).not.toBe(workDays);
    expect('shift_start' in payload).toBe(false);
    expect('shift_end' in payload).toBe(false);
  });

  it('derives shift_schedule from shift hours alone and includes the raw bounds', () => {
    const payload = jobFormToCreatePayload({ ...base, shift_start: '07:00', shift_end: '16:00' });
    expect(payload.shift_schedule).toBe('7:00 AM–4:00 PM');
    expect(payload.shift_start).toBe('07:00');
    expect(payload.shift_end).toBe('16:00');
    expect('work_days' in payload).toBe(false);
  });

  it('derives a combined shift_schedule when both days and hours are present', () => {
    const payload = jobFormToCreatePayload({ ...base, work_days: ['mon', 'tue'], shift_start: '07:00', shift_end: '16:00' });
    expect(payload.shift_schedule).toBe('Mon–Tue · 7:00 AM–4:00 PM');
  });

  it('passes the legacy shift_schedule text through untouched when nothing structured is set', () => {
    const payload = jobFormToCreatePayload({ ...base, shift_schedule: 'Mon-Fri day shift' });
    expect(payload.shift_schedule).toBe('Mon-Fri day shift');
    expect('work_days' in payload).toBe(false);
    expect('shift_start' in payload).toBe(false);
    expect('shift_end' in payload).toBe(false);
  });

  it('a one-sided shift (start only) still triggers derivation and omits the unset bound', () => {
    const payload = jobFormToCreatePayload({ ...base, shift_start: '07:00' });
    expect(payload.shift_schedule).toBe('From 7:00 AM');
    expect(payload.shift_start).toBe('07:00');
    expect('shift_end' in payload).toBe(false);
  });
});

describe('jobFormToBasePayload (via jobFormToCreatePayload): certification_requirements payload rule', () => {
  const certs: CertificationRequirement[] = [{ name: 'OSHA 10', tier: 'required', proof_required: true }];
  const base: JobForm = {
    ...initialForm, title: 'Job', location: 'Reno, NV', trade_category: 'concrete',
    requirements: setRequirementState(initialForm.requirements, 'certification_doc', 'optional'),
  };

  it('when certs are present: emits certification_requirements with exactly {name, tier, proof_required}', () => {
    const payload = jobFormToCreatePayload({ ...base, certification_requirements: certs });
    expect(payload.certification_requirements).toEqual([{ name: 'OSHA 10', tier: 'required', proof_required: true }]);
  });

  it('when certs are present: certifications is the derived name list', () => {
    const payload = jobFormToCreatePayload({ ...base, certification_requirements: certs });
    expect(payload.certifications).toEqual(['OSHA 10']);
  });

  it('when certs are present: certification_doc is force-stripped from BOTH doc arrays regardless of its own tier', () => {
    const requiredTier = jobFormToCreatePayload({
      ...base,
      requirements: setRequirementState(initialForm.requirements, 'certification_doc', 'required'),
      certification_requirements: certs,
    });
    expect(requiredTier.required_docs).not.toContain('certification_doc');
    expect(requiredTier.optional_docs).not.toContain('certification_doc');

    const optionalTier = jobFormToCreatePayload({ ...base, certification_requirements: certs });
    expect(optionalTier.required_docs).not.toContain('certification_doc');
    expect(optionalTier.optional_docs).not.toContain('certification_doc');
  });

  it('when certs are empty: certification_requirements is omitted and certification_doc is left alone', () => {
    const payload = jobFormToCreatePayload({ ...base, certifications: 'OSHA 10, CPR' });
    expect('certification_requirements' in payload).toBe(false);
    expect(payload.certifications).toEqual(['OSHA 10', 'CPR']);
    expect(payload.optional_docs).toContain('certification_doc');
  });

  it('trims and drops blank cert names, keeping certifications and certification_requirements in exact agreement', () => {
    const messy: CertificationRequirement[] = [
      { name: '  OSHA 10  ', tier: 'required', proof_required: true },
      { name: '   ', tier: 'optional', proof_required: false },
    ];
    const payload = jobFormToCreatePayload({ ...base, certification_requirements: messy });
    expect(payload.certifications).toEqual(['OSHA 10']);
    expect(payload.certification_requirements).toEqual([{ name: 'OSHA 10', tier: 'required', proof_required: true }]);
  });
});

describe('jobToForm: FE-T3 structured field parsing', () => {
  it('parses trade_category_other, defaulting to empty when absent', () => {
    expect(jobToForm({ ...baseJob, trade_category_other: 'Welder' }).trade_category_other).toBe('Welder');
    expect(jobToForm({ ...baseJob, trade_category_other: undefined }).trade_category_other).toBe('');
  });

  it('parses a valid expected_duration_bucket and rejects an unrecognized one', () => {
    expect(jobToForm({ ...baseJob, expected_duration_bucket: '2_4w' }).expected_duration_bucket).toBe('2_4w');
    expect(jobToForm({ ...baseJob, expected_duration_bucket: 'bogus' as never }).expected_duration_bucket).toBe('');
    expect(jobToForm({ ...baseJob, expected_duration_bucket: undefined }).expected_duration_bucket).toBe('');
  });

  it('parses work_days, filtering out any value outside the allowlist', () => {
    expect(jobToForm({ ...baseJob, work_days: ['mon', 'tue'] }).work_days).toEqual(['mon', 'tue']);
    expect(jobToForm({ ...baseJob, work_days: ['mon', 'bogus'] as never }).work_days).toEqual(['mon']);
    expect(jobToForm({ ...baseJob, work_days: undefined }).work_days).toEqual([]);
    expect(jobToForm({ ...baseJob, work_days: null as never }).work_days).toEqual([]);
  });

  it('normalizes a Postgres HH:MM:SS shift time down to HH:MM', () => {
    expect(jobToForm({ ...baseJob, shift_start: '07:00:00' as never }).shift_start).toBe('07:00');
    expect(jobToForm({ ...baseJob, shift_end: '16:00:30.5' as never }).shift_end).toBe('16:00');
  });

  it('leaves an already-HH:MM shift time untouched', () => {
    expect(jobToForm({ ...baseJob, shift_start: '07:00' }).shift_start).toBe('07:00');
  });

  it('defaults shift_start/shift_end to empty when absent or unparseable', () => {
    expect(jobToForm({ ...baseJob, shift_start: undefined, shift_end: null as never }).shift_start).toBe('');
    expect(jobToForm({ ...baseJob, shift_end: null as never }).shift_end).toBe('');
    expect(jobToForm({ ...baseJob, shift_start: 'garbage' as never }).shift_start).toBe('');
  });
});

describe('jobToForm: certification_requirements -- direct load vs. legacy seeding', () => {
  it('loads certification_requirements directly when the job already has them, ignoring legacy fields entirely', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certification_requirements: [{ name: 'CPR', tier: 'optional', proof_required: false }],
      certifications: ['Ignored Legacy Name'],
      required_docs: ['certification_doc'],
    };
    expect(jobToForm(job).certification_requirements).toEqual([{ name: 'CPR', tier: 'optional', proof_required: false }]);
  });

  it('seeds one required cert per legacy name when certification_doc is Required', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certifications: ['OSHA 10', 'CPR'],
      required_docs: ['certification_doc'],
    };
    expect(jobToForm(job).certification_requirements).toEqual([
      { name: 'OSHA 10', tier: 'required', proof_required: true },
      { name: 'CPR', tier: 'required', proof_required: true },
    ]);
  });

  it('seeds one optional cert per legacy name when certification_doc is Optional', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certifications: ['OSHA 10'],
      required_docs: [],
      optional_docs: ['certification_doc'],
    };
    expect(jobToForm(job).certification_requirements).toEqual([
      { name: 'OSHA 10', tier: 'optional', proof_required: true },
    ]);
  });

  it('does NOT seed when the legacy certification_doc tier is Off', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certifications: ['OSHA 10'],
      required_docs: [],
      optional_docs: [],
    };
    expect(jobToForm(job).certification_requirements).toEqual([]);
  });

  it('seeds nothing when there are no legacy certification names to seed from', () => {
    const job: EmployerJobDetail = { ...baseJob, certifications: [], required_docs: ['certification_doc'] };
    expect(jobToForm(job).certification_requirements).toEqual([]);
  });

  // Adversarial-review regression pins: seeding is skipped once the job has
  // applicants. A seeded save drops certification_doc from the (locked) docs
  // arrays, so seeding a locked legacy job would make EVERY save of it fail
  // -- even a title fix. Stored per-cert data still round-trips regardless.
  it('does NOT seed from legacy fields when the job has applicants (locked docs arrays)', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certifications: ['OSHA 10', 'CPR'],
      required_docs: ['certification_doc'],
      applicant_count: 3,
    };
    expect(jobToForm(job).certification_requirements).toEqual([]);
  });

  it('still loads STORED certification_requirements when the job has applicants', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certification_requirements: [{ name: 'CPR', tier: 'optional', proof_required: false }],
      applicant_count: 3,
    };
    expect(jobToForm(job).certification_requirements).toEqual([{ name: 'CPR', tier: 'optional', proof_required: false }]);
  });

  it('locked legacy job round-trips its legacy shape untouched (no cert seeding, certification_doc stays in required_docs)', () => {
    const job: EmployerJobDetail = {
      ...baseJob,
      certifications: ['OSHA 10'],
      required_docs: ['certification_doc', 'resume'],
      applicant_count: 1,
    };
    const form = jobToForm(job);
    const payload = jobFormToCreatePayload(form);
    expect(payload.certifications).toEqual(['OSHA 10']);
    expect(payload.required_docs).toEqual(expect.arrayContaining(['certification_doc', 'resume']));
    expect(payload.certification_requirements).toBeUndefined();
  });
});

describe('headline: jobToForm -> jobFormToCreatePayload round-trip for a pre-FE-T3 legacy job', () => {
  // The identity case REQUIRES certification_doc's legacy tier to be 'off':
  // any other tier makes jobToForm's (correct) legacy-seeding rule populate
  // certification_requirements, which then makes the (also correct) payload
  // rule strip certification_doc and emit certification_requirements --  an
  // intentional divergence covered separately below, not a round-trip.
  const legacyJob: EmployerJobDetail = {
    ...baseJob,
    expected_duration: 'About 2 weeks',
    shift_schedule: 'Mon-Fri, 7am-4pm',
    certifications: ['OSHA 10', 'CPR'],
    required_docs: [],
    optional_docs: [],
    // No trade_category_other / expected_duration_bucket / work_days /
    // shift_start / shift_end / certification_requirements at all -- a
    // job row from before migration 077, or a client that hasn't been
    // updated to request the new columns.
  };

  it('reproduces the three legacy strings byte-for-byte and omits all six new fields', () => {
    const form = jobToForm(legacyJob);
    const payload = jobFormToCreatePayload(form);

    expect(payload.expected_duration).toBe('About 2 weeks');
    expect(payload.shift_schedule).toBe('Mon-Fri, 7am-4pm');
    expect(payload.certifications).toEqual(['OSHA 10', 'CPR']);

    const wire = JSON.parse(JSON.stringify(payload));
    for (const key of ['trade_category_other', 'expected_duration_bucket', 'work_days', 'shift_start', 'shift_end', 'certification_requirements']) {
      expect(wire).not.toHaveProperty(key);
      expect(key in payload).toBe(false);
    }
  });

  it('the same job WITH certification_doc Required seeds certs and intentionally diverges from identity', () => {
    const seededJob: EmployerJobDetail = { ...legacyJob, required_docs: ['certification_doc'] };
    const form = jobToForm(seededJob);
    const payload = jobFormToCreatePayload(form);

    expect(payload.certification_requirements).toEqual([
      { name: 'OSHA 10', tier: 'required', proof_required: true },
      { name: 'CPR', tier: 'required', proof_required: true },
    ]);
    expect(payload.certifications).toEqual(['OSHA 10', 'CPR']);
    expect(payload.required_docs).not.toContain('certification_doc');
    expect(payload.optional_docs).not.toContain('certification_doc');
  });
});

describe('jobFormFromTemplatePayload: FE-T3 additive fields', () => {
  it('carries all six new fields through from a template payload', () => {
    const { form } = jobFormFromTemplatePayload({
      title: 'Concrete Finisher', location: 'El Paso, TX', job_type: 'contract' as const,
      trade_category: 'other', trade_category_other: 'Welder',
      expected_duration_bucket: '1_2w', work_days: ['mon', 'wed', 'fri'],
      shift_start: '08:00', shift_end: '17:00',
      certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: true }],
    } as never);

    expect(form.trade_category_other).toBe('Welder');
    expect(form.expected_duration_bucket).toBe('1_2w');
    expect(form.work_days).toEqual(['mon', 'wed', 'fri']);
    expect(form.shift_start).toBe('08:00');
    expect(form.shift_end).toBe('17:00');
    expect(form.certification_requirements).toEqual([{ name: 'OSHA 10', tier: 'required', proof_required: true }]);
  });

  it('defaults all six fields for an old template payload that predates them', () => {
    const { form } = jobFormFromTemplatePayload({
      title: 'Old Template', location: 'Reno, NV', job_type: 'full-time' as const, trade_category: 'other',
    });
    expect(form.trade_category_other).toBe('');
    expect(form.expected_duration_bucket).toBe('');
    expect(form.work_days).toEqual([]);
    expect(form.shift_start).toBe('');
    expect(form.shift_end).toBe('');
    expect(form.certification_requirements).toEqual([]);
  });
});

describe('pre-application prompts (migration 091)', () => {
  it('starts empty on a fresh form', () => {
    expect(initialForm.pre_application_prompts).toEqual([]);
  });

  it('ALWAYS emits the key, `[]` included -- the same always-send contract as the four arrays', () => {
    const payload = jobFormToCreatePayload(base);
    expect('pre_application_prompts' in payload).toBe(true);
    expect(payload.pre_application_prompts).toEqual([]);

    const edit = jobFormToEditPayload(base, { state_region: '' });
    expect(edit.pre_application_prompts).toEqual([]);
  });

  it('trims each question and drops the blank row an untouched Add leaves behind', () => {
    const payload = jobFormToCreatePayload({
      ...base,
      pre_application_prompts: [
        { id: 'p1', text: '  What tools do you bring?  ' },
        { id: 'p2', text: '   ' },
      ],
    });
    expect(payload.pre_application_prompts).toEqual([{ id: 'p1', text: 'What tools do you bring?' }]);
  });

  it('round-trips a stored job byte-identically, ids included, so the lock sees no change', () => {
    // The post-applicants lock compares the arriving list against the stored
    // one by CONTENT. A re-minted id would read as an edit and 409
    // `field_locked` -- making every later save of the job fail, even a title
    // fix (the same scar `seedCertificationRequirements` carries).
    const stored = [
      { id: 'aaaa-1', text: 'Tell me about the biggest pour you have finished.' },
      { id: 'bbbb-2', text: 'What tools do you bring to a job?' },
    ];
    const job: EmployerJobDetail = { ...baseJob, applicant_count: 3, pre_application_prompts: stored };
    const form = jobToForm(job);
    expect(form.pre_application_prompts).toEqual(stored);
    expect(jobFormToEditPayload(form, form).pre_application_prompts).toEqual(stored);
  });

  it('reads a job from before the feature as asking nothing', () => {
    expect(jobToForm(baseJob).pre_application_prompts).toEqual([]);
    expect(jobToForm({ ...baseJob, pre_application_prompts: null as never }).pre_application_prompts).toEqual([]);
  });

  it('carries prompts through a saved template payload', () => {
    const { form } = jobFormFromTemplatePayload({
      title: 'x', location: 'El Paso, TX', job_type: 'contract' as const,
      pre_application_prompts: [{ id: 't1', text: 'How far will you drive?' }],
    } as never);
    expect(form.pre_application_prompts).toEqual([{ id: 't1', text: 'How far will you drive?' }]);
  });
});

describe('validateFullJobForm: prompt codes', () => {
  // `base` is deliberately trade_category 'other' with no custom trade text,
  // so it fails step 1 on its own -- these cases need a form whose only
  // possible complaint is the prompts.
  const valid: JobForm = {
    ...base,
    trade_category: 'concrete',
    city_key: 'el-paso-tx', city: 'El Paso', state: 'TX', state_region: 'TX',
  };

  it('rejects a blank question row', () => {
    expect(validateFullJobForm({ ...valid, pre_application_prompts: [{ id: 'p1', text: '  ' }] }))
      .toBe('prompt_blank');
    expect(validateStepRequirements({ ...valid, pre_application_prompts: [{ id: 'p1', text: '  ' }] }))
      .toBe('prompt_blank');
  });

  it('rejects a question past the hard 500-character bound, not the 300 counter guide', () => {
    expect(validateFullJobForm({ ...valid, pre_application_prompts: [{ id: 'p1', text: 'x'.repeat(301) }] }))
      .toBeNull();
    expect(validateFullJobForm({ ...valid, pre_application_prompts: [{ id: 'p1', text: 'x'.repeat(501) }] }))
      .toBe('prompt_too_long');
  });

  it('reports the earlier step first -- a broken step 1 outranks a broken prompt', () => {
    expect(validateFullJobForm({ ...valid, title: '', pre_application_prompts: [{ id: 'p1', text: '' }] }))
      .toBe('required');
  });

  it('passes a job that asks nothing', () => {
    expect(validateFullJobForm(valid)).toBeNull();
  });
});
