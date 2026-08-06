import { describe, expect, it } from 'vitest';
import { initialForm, jobFormToPayload, validateJobLocationFields } from '@/lib/job-form';

describe('jobFormToPayload city/state_region', () => {
  it('serializes city and state_region as null (an explicit clear) when both are empty', () => {
    const payload = jobFormToPayload({ ...initialForm, title: 'Job', location: 'Hayward, CA', trade_category: 'electrician' });
    // `null` -- not omitted -- is the wire signal the backend's
    // resolveJobLocationFields treats as a deliberate clear-override. Blank
    // used to mean "omit" (defer to the parsed location); it now means
    // "clear", because the Edit modal is prefilled with the job's stored
    // city/state_region, so a blanked-out field is a deliberate choice.
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('city', null);
    expect(wire).toHaveProperty('state_region', null);
  });

  it('trims and includes city when present', () => {
    const payload = jobFormToPayload({ ...initialForm, city: '  Hayward  ' });
    expect(payload.city).toBe('Hayward');
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

  it('serializes city as null when it is only whitespace', () => {
    const payload = jobFormToPayload({ ...initialForm, city: '   ' });
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('city', null);
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
