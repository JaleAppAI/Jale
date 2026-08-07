import { describe, it, expect } from 'vitest';
import {
  applyLocationToJobForm, initialForm, jobFormToPayload, jobToForm, validateJobLocationFields, type JobForm,
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

describe('jobFormToPayload city + coordinates', () => {
  it('includes the city triple and coordinates when picked', () => {
    const payload = jobFormToPayload({
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
    const payload = jobFormToPayload(base);
    expect('city_key' in payload).toBe(false);
    expect('city' in payload).toBe(false);
    expect('state' in payload).toBe(false);
    expect('latitude' in payload).toBe(false);
    expect('longitude' in payload).toBe(false);
  });

  it('omits the whole city triple when it is only partially picked', () => {
    const payload = jobFormToPayload({
      ...base,
      city_key: 'el-paso-tx', city: 'El Paso', state: null,
    });
    expect('city_key' in payload).toBe(false);
    expect('city' in payload).toBe(false);
    expect('state' in payload).toBe(false);
  });

  it('still sends coordinates when no city has been picked (gates are independent)', () => {
    const payload = jobFormToPayload({
      ...base,
      latitude: 31.76, longitude: -106.49,
    });
    expect('city_key' in payload).toBe(false);
    expect(payload).toMatchObject({ latitude: 31.76, longitude: -106.49 });
  });

  it('sends latitude/longitude of 0 (a `!= null` gate, not truthiness)', () => {
    const payload = jobFormToPayload({
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
// 'jobFormToPayload city + coordinates' and 'applyLocationToJobForm'), and
// this frontend has no separate free-text SEO city input to exercise. Only
// state_region -- which IS a genuinely new, independent field -- is added.
// ---------------------------------------------------------------------------

describe('jobFormToPayload state_region', () => {
  it('serializes state_region as null (an explicit clear) when empty, independent of the city triple', () => {
    const payload = jobFormToPayload({ ...initialForm, title: 'Job', location: 'Hayward, CA', trade_category: 'electrician' });
    // `null` -- not omitted -- is the wire signal the backend's
    // resolveJobLocationFields treats as a deliberate clear-override. Blank
    // used to mean "omit" (defer to the parsed location); it now means
    // "clear", because the Edit modal is prefilled with the job's stored
    // state_region, so a blanked-out field is a deliberate choice.
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('state_region', null);
    // Untouched by state_region: the city triple is still all-or-none omitted.
    expect('city' in payload).toBe(false);
  });

  it('uppercases a lowercase state_region in the payload', () => {
    const payload = jobFormToPayload({ ...initialForm, state_region: 'ca' });
    expect(payload.state_region).toBe('CA');
  });

  it('trims whitespace around state_region before uppercasing', () => {
    const payload = jobFormToPayload({ ...initialForm, state_region: '  tx  ' });
    expect(payload.state_region).toBe('TX');
  });

  it('serializes state_region as null when it is only whitespace', () => {
    const payload = jobFormToPayload({ ...initialForm, state_region: '   ' });
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('state_region', null);
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
