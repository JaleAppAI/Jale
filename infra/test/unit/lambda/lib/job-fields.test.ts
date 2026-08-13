import {
  formatPayRangeLocalized,
  normalizeApplicationStatus,
  parseJobFields,
  parseOptionalCoordinates,
  payNotSpecifiedLabel,
} from '../../../../lambda/lib/job-fields';

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

describe('parseOptionalCoordinates', () => {
  it('returns null when neither coordinate is present', () => {
    expect(parseOptionalCoordinates({ title: 'Framer' })).toEqual({ ok: true, value: null });
  });

  it('accepts a complete, in-range pair', () => {
    expect(parseOptionalCoordinates({ latitude: 30.27, longitude: -97.74 }))
      .toEqual({ ok: true, value: { latitude: 30.27, longitude: -97.74 } });
  });

  it('accepts the exact bounds', () => {
    expect(parseOptionalCoordinates({ latitude: -90, longitude: 180 }))
      .toEqual({ ok: true, value: { latitude: -90, longitude: 180 } });
  });

  it.each([
    ['only latitude', { latitude: 30.27 }],
    ['only longitude', { longitude: -97.74 }],
  ])('rejects %s with invalid_coordinates', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_coordinates' });
  });

  it.each([
    ['out-of-range high latitude', { latitude: 91, longitude: -97.74 }],
    ['out-of-range low latitude', { latitude: -91, longitude: -97.74 }],
    ['non-numeric latitude', { latitude: '30.27', longitude: -97.74 }],
    ['non-finite latitude', { latitude: Number.POSITIVE_INFINITY, longitude: -97.74 }],
  ])('rejects %s with invalid_latitude', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_latitude' });
  });

  it.each([
    ['out-of-range high longitude', { latitude: 30.27, longitude: 181 }],
    ['out-of-range low longitude', { latitude: 30.27, longitude: -181 }],
    ['non-numeric longitude', { latitude: 30.27, longitude: '-97.74' }],
    ['non-finite longitude', { latitude: 30.27, longitude: Number.NaN }],
  ])('rejects %s with invalid_longitude', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_longitude' });
  });

  it('treats an explicitly null coordinate as present, not absent', () => {
    // hasOwnProperty semantics: { latitude: null, longitude: null } is a malformed
    // pair, not an omission — it must not silently parse as "no coordinates".
    expect(parseOptionalCoordinates({ latitude: null, longitude: null }))
      .toEqual({ ok: false, error: 'invalid_latitude' });
  });
});

describe('formatPayRangeLocalized', () => {
  it('returns null when both bounds are null, for either locale', () => {
    expect(formatPayRangeLocalized(null, null, null, 'en')).toBeNull();
    expect(formatPayRangeLocalized(null, null, null, 'es')).toBeNull();
    expect(formatPayRangeLocalized(null, null, 'hourly', 'es')).toBeNull();
  });

  it('renders a "From"/"Desde" one-sided range when only pay_min is set', () => {
    expect(formatPayRangeLocalized(15, null, null, 'en')).toBe('From $15');
    expect(formatPayRangeLocalized(15, null, null, 'es')).toBe('Desde $15');
  });

  it('renders an "Up to"/"Hasta" one-sided range when only pay_max is set', () => {
    expect(formatPayRangeLocalized(null, 20, null, 'en')).toBe('Up to $20');
    expect(formatPayRangeLocalized(null, 20, null, 'es')).toBe('Hasta $20');
  });

  it('collapses to a single figure when pay_min equals pay_max', () => {
    expect(formatPayRangeLocalized(15, 15, null, 'en')).toBe('$15');
    expect(formatPayRangeLocalized(15, 15, null, 'es')).toBe('$15');
  });

  it('renders a full range when pay_min and pay_max differ', () => {
    expect(formatPayRangeLocalized(15, 20, null, 'en')).toBe('$15-$20');
    expect(formatPayRangeLocalized(15, 20, null, 'es')).toBe('$15-$20');
  });

  it.each([
    ['hourly', '/hour', '/hora'],
    ['daily', '/day', '/dia'],
    ['weekly', '/week', '/semana'],
    ['monthly', '/month', '/mes'],
  ] as const)('appends the %s interval as a per-unit suffix in both locales', (interval, enSuffix, esSuffix) => {
    expect(formatPayRangeLocalized(15, 20, interval, 'en')).toBe(`$15-$20${enSuffix}`);
    expect(formatPayRangeLocalized(15, 20, interval, 'es')).toBe(`$15-$20${esSuffix}`);
  });

  it('renders the fixed interval as a parenthetical qualifier, not a per-unit suffix', () => {
    expect(formatPayRangeLocalized(500, 500, 'fixed', 'en')).toBe('$500 (fixed)');
    expect(formatPayRangeLocalized(500, 500, 'fixed', 'es')).toBe('$500 (fijo)');
  });

  it('ignores an unknown/unrecognized interval rather than appending a suffix', () => {
    expect(formatPayRangeLocalized(15, 20, 'biweekly', 'en')).toBe('$15-$20');
    expect(formatPayRangeLocalized(15, 20, 'biweekly', 'es')).toBe('$15-$20');
  });
});

describe('payNotSpecifiedLabel', () => {
  it('returns the localized "not specified" placeholder for each locale', () => {
    expect(payNotSpecifiedLabel('en')).toBe('Pay not specified');
    expect(payNotSpecifiedLabel('es')).toBe('Pago no especificado');
  });
});
