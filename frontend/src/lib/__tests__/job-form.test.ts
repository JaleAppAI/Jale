import { describe, expect, it } from 'vitest';
import {
  initialForm,
  jobFormToCreatePayload,
  jobFormToEditPayload,
  validateJobLocationFields,
} from '@/lib/job-form';

describe('jobFormToCreatePayload city/state_region', () => {
  it('create+blank: omits city and state_region entirely (undefined -> backend auto-parses location)', () => {
    const payload = jobFormToCreatePayload({
      ...initialForm,
      title: 'Job',
      location: 'Hayward, CA',
      trade_category: 'electrician',
    });
    // There is no previously-stored value to protect on create, so a blank
    // field must be OMITTED (key absent), not sent as an explicit `null` --
    // an explicit null would override the backend's auto-parse of `location`
    // and clear city/state_region on every create where the employer left
    // these fields blank (the prod-live bug this fix addresses).
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('city');
    expect(wire).not.toHaveProperty('state_region');
    expect(payload.city).toBeUndefined();
    expect(payload.state_region).toBeUndefined();
  });

  it('create+filled: includes the trimmed city and uppercased state_region', () => {
    const payload = jobFormToCreatePayload({
      ...initialForm,
      city: '  Hayward  ',
      state_region: 'ca',
    });
    expect(payload.city).toBe('Hayward');
    expect(payload.state_region).toBe('CA');
  });

  it('trims whitespace-only city/state_region down to omitted, same as fully blank', () => {
    const payload = jobFormToCreatePayload({ ...initialForm, city: '   ', state_region: '   ' });
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('city');
    expect(wire).not.toHaveProperty('state_region');
  });
});

describe('jobFormToEditPayload city/state_region', () => {
  it('edit prefilled->blanked: sends an explicit null clear-override for a field that started non-empty', () => {
    const initial = { ...initialForm, city: 'El Paso', state_region: 'TX' };
    const blanked = { ...initial, city: '', state_region: '' };
    const payload = jobFormToEditPayload(blanked, initial);
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('city', null);
    expect(wire).toHaveProperty('state_region', null);
  });

  it('edit blank->blank: omits the keys when the field started empty and is still empty', () => {
    const initial = { ...initialForm, city: '', state_region: '' };
    const stillBlank = { ...initial };
    const payload = jobFormToEditPayload(stillBlank, initial);
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).not.toHaveProperty('city');
    expect(wire).not.toHaveProperty('state_region');
  });

  it('edit filled->filled: sends the new trimmed/uppercased values regardless of the initial value', () => {
    const initial = { ...initialForm, city: 'El Paso', state_region: 'TX' };
    const edited = { ...initial, city: '  Austin  ', state_region: 'tx' };
    const payload = jobFormToEditPayload(edited, initial);
    expect(payload.city).toBe('Austin');
    expect(payload.state_region).toBe('TX');
  });

  it('edit blank->filled: sends the new value even though the field started empty', () => {
    const initial = { ...initialForm, city: '', state_region: '' };
    const filled = { ...initial, city: 'Hayward', state_region: 'ca' };
    const payload = jobFormToEditPayload(filled, initial);
    expect(payload.city).toBe('Hayward');
    expect(payload.state_region).toBe('CA');
  });

  it('the two fields are independent: only the one that started non-empty and is now blank gets an explicit null', () => {
    const initial = { ...initialForm, city: 'El Paso', state_region: '' };
    const edited = { ...initial, city: '', state_region: '' };
    const payload = jobFormToEditPayload(edited, initial);
    const wire = JSON.parse(JSON.stringify(payload));
    expect(wire).toHaveProperty('city', null);
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
