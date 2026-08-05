import { parseJobLocation, resolveJobLocationFields } from '../../../../lambda/lib/job-location-parse';

describe('parseJobLocation', () => {
  const cases: Array<[string | null | undefined, { city: string; state_region: string } | null]> = [
    // Real prod shapes (from a live sample) -- these six must all resolve exactly as noted.
    ['79928', null],
    ['Austin', { city: 'Austin', state_region: 'TX' }],
    ['Austin, TX', { city: 'Austin', state_region: 'TX' }],
    ['El Paso', { city: 'El Paso', state_region: 'TX' }],
    ['El paso tx', { city: 'El Paso', state_region: 'TX' }],
    ['El paso Tx', { city: 'El Paso', state_region: 'TX' }],

    // Other curated-city coverage.
    ['san antonio', { city: 'San Antonio', state_region: 'TX' }],
    ['HOUSTON', { city: 'Houston', state_region: 'TX' }],
    ['Round Rock', { city: 'Round Rock', state_region: 'TX' }],
    ['Corpus Christi', { city: 'Corpus Christi', state_region: 'TX' }],

    // Comma-delimited, full state name.
    ['Austin, Texas', { city: 'Austin', state_region: 'TX' }],
    ['  Dallas ,  tx  ', { city: 'Dallas', state_region: 'TX' }],

    // Non-Texas states still resolve when a state token is present.
    ['Columbus, OH', { city: 'Columbus', state_region: 'OH' }],
    ['Denver CO', { city: 'Denver', state_region: 'CO' }],

    // Unparseable / never-guess cases.
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
    ['78701-1234', null],
    ['Columbus', null], // bare non-Texas city, no state token -- not in the allowlist
    ['XX', null],
    ['Somewhere Nowhere', null],
  ];

  it.each(cases)('parses %j -> %j', (input, expected) => {
    expect(parseJobLocation(input)).toEqual(expected);
  });

  it('title-cases a lowercase multi-word city', () => {
    expect(parseJobLocation('new braunfels')).toEqual({ city: 'New Braunfels', state_region: 'TX' });
  });

  it('never throws on garbage input', () => {
    expect(() => parseJobLocation('!!!, ??')).not.toThrow();
    expect(parseJobLocation('!!!, ??')).toBeNull();
  });
});

describe('resolveJobLocationFields', () => {
  it('uses the parsed values when no explicit fields are given', () => {
    const res = resolveJobLocationFields('Austin, TX', undefined, undefined);
    expect(res).toEqual({ ok: true, value: { city: 'Austin', state_region: 'TX' } });
  });

  it('returns nulls when the location is unparseable and no explicit fields are given', () => {
    const res = resolveJobLocationFields('79928', undefined, undefined);
    expect(res).toEqual({ ok: true, value: { city: null, state_region: null } });
  });

  it('explicit city wins over the parsed city', () => {
    const res = resolveJobLocationFields('Austin, TX', 'North Austin', undefined);
    expect(res).toEqual({ ok: true, value: { city: 'North Austin', state_region: 'TX' } });
  });

  it('explicit state_region wins over the parsed state, normalized to uppercase', () => {
    const res = resolveJobLocationFields('Austin, TX', undefined, 'ok');
    expect(res).toEqual({ ok: true, value: { city: 'Austin', state_region: 'OK' } });
  });

  it('explicit fields can rescue an otherwise-unparseable location', () => {
    const res = resolveJobLocationFields('79928', 'El Paso', 'tx');
    expect(res).toEqual({ ok: true, value: { city: 'El Paso', state_region: 'TX' } });
  });

  it('rejects a blank explicit city', () => {
    const res = resolveJobLocationFields('Austin, TX', '   ', undefined);
    expect(res).toEqual({ ok: false, error: 'invalid_city' });
  });

  it('rejects an explicit city over 120 characters', () => {
    const res = resolveJobLocationFields('Austin, TX', 'A'.repeat(121), undefined);
    expect(res).toEqual({ ok: false, error: 'invalid_city' });
  });

  it('rejects an explicit state_region that is not exactly 2 letters', () => {
    const res = resolveJobLocationFields('Austin, TX', undefined, 'Texas');
    expect(res).toEqual({ ok: false, error: 'invalid_state_region' });
  });

  it('rejects a non-string explicit city or state_region', () => {
    expect(resolveJobLocationFields('Austin, TX', 123, undefined)).toEqual({ ok: false, error: 'invalid_city' });
    expect(resolveJobLocationFields('Austin, TX', undefined, 123)).toEqual({ ok: false, error: 'invalid_state_region' });
  });
});
