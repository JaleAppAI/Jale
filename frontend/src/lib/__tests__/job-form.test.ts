import { describe, it, expect } from 'vitest';
import {
  applyLocationToJobForm, initialForm, jobFormToCreatePayload, jobFormToEditPayload, jobToForm, validateJobLocationFields, jobFormFromTemplatePayload, templateRowSummary, type JobForm,
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
    expect(form.required_docs).toEqual({ resume: true, driver_license: false });
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

  it('formats one-sided pay ranges', () => {
    expect(templateRowSummary({ pay_min: 20 }).pay).toBe('$20+');
    expect(templateRowSummary({ pay_max: 30 }).pay).toBe('Up to $30');
  });

  it('joins a provided interval label onto real pay, never onto the em dash', () => {
    expect(templateRowSummary({ pay_min: 20, pay_max: 28 }, 'per hour').pay).toBe('$20–$28 · per hour');
    expect(templateRowSummary({}, 'per hour').pay).toBe('—');
  });
});
