import { describe, expect, it } from 'vitest';
import { initialForm, jobFormToPayload, validateJobLocationFields } from '@/lib/job-form';

describe('jobFormToPayload city/state_region', () => {
  it('omits city and state_region from the wire payload when both are empty', () => {
    const payload = jobFormToPayload({ ...initialForm, title: 'Job', location: 'Hayward, CA', trade_category: 'electrician' });
    // "Omitted" means the key must not survive JSON serialization -- the
    // actual wire contract apiFetch sends -- not merely `=== undefined` on
    // the in-memory object (which `toEqual` can't distinguish from absent).
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('city');
    expect(wire).not.toHaveProperty('state_region');
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

  it('omits state_region when it is only whitespace', () => {
    const payload = jobFormToPayload({ ...initialForm, state_region: '   ' });
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('state_region');
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
