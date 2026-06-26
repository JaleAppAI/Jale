import { normalizeApplicationStatus, parseJobFields } from '../../../../lambda/lib/job-fields';

const validBody = {
  pay_min: 25,
  pay_max: 30,
  start_date: '2026-06-15',
  transportation_required: false,
  language_preference: ['any'],
  number_of_workers_needed: 3,
  trade_category: 'concrete',
  required_experience_months: 24,
  required_experience_years: 2,
  certifications: ['OSHA 10'],
};

describe('job-fields parser', () => {
  it('accepts the strict MVP hiring-flow field bounds', () => {
    const result = parseJobFields({
      ...validBody,
      pay_min: 9999,
      pay_max: 9999,
      number_of_workers_needed: 500,
      required_experience_years: 80,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        pay_min: 9999,
        pay_max: 9999,
        number_of_workers_needed: 500,
        required_experience_years: 80,
        required_experience_months: 24,
      }),
    });
  });

  it.each([
    ['June 2026'],
    ['1 Jan 2026'],
    ['2026'],
    ['2026-13-01'],
    ['2026-02-30'],
  ])('rejects ambiguous or invalid start dates: %s', (startDate) => {
    const result = parseJobFields({ ...validBody, start_date: startDate });

    expect(result).toEqual({ ok: false, error: 'invalid_start_date' });
  });

  it.each([
    ['pay_min', 10000, 'invalid_pay_min'],
    ['pay_max', 10000, 'invalid_pay_max'],
    ['number_of_workers_needed', 501, 'invalid_number_of_workers_needed'],
    ['required_experience_years', 81, 'invalid_required_experience_years'],
    ['required_experience_months', 961, 'invalid_required_experience_months'],
  ])('rejects out-of-range %s', (field, value, error) => {
    const result = parseJobFields({ ...validBody, [field]: value });

    expect(result).toEqual({ ok: false, error });
  });

  it('accepts pay intervals and converts legacy required years to canonical months', () => {
    const result = parseJobFields({
      ...validBody,
      pay_interval: 'weekly',
      required_experience_months: undefined,
      required_experience_years: 3,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        pay_interval: 'weekly',
        required_experience_years: 3,
        required_experience_months: 36,
      }),
    });
  });

  it('rejects invalid pay intervals', () => {
    const result = parseJobFields({ ...validBody, pay_interval: 'biweekly' });

    expect(result).toEqual({
      ok: false,
      error: 'invalid_pay_interval',
      valid: ['hourly', 'daily', 'weekly', 'monthly', 'fixed'],
    });
  });

  it('rejects oversized language preference arrays before normalization', () => {
    const result = parseJobFields({ ...validBody, language_preference: ['en', 'es', 'en', 'es', 'en', 'es', 'en'] });

    expect(result).toEqual({
      ok: false,
      error: 'invalid_language_preference',
      valid: ['any', 'en', 'es'],
    });
  });

  it.each([
    ['too many certifications', Array.from({ length: 21 }, (_, index) => `cert-${index}`)],
    ['oversized certification', ['A'.repeat(201)]],
    ['blank certification', ['OSHA 10', '   ']],
    ['non-string certification', ['OSHA 10', 123]],
  ])('rejects %s', (_caseName, certifications) => {
    const result = parseJobFields({ ...validBody, certifications });

    expect(result).toEqual({ ok: false, error: 'invalid_certifications' });
  });

  it('normalizes legacy application statuses and rejects unknown statuses', () => {
    expect(normalizeApplicationStatus('reviewed')).toBe('contacted');
    expect(normalizeApplicationStatus('rejected')).toBe('not_interested');
    expect(normalizeApplicationStatus('hired')).toBe('hired');
    expect(normalizeApplicationStatus('bogus')).toBeNull();
  });
});
