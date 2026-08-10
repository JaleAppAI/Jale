import { slugCityKey, parseCityFields, parsePreferredCities, parseCityFromLocation } from '../../../../lambda/lib/city-fields';

describe('slugCityKey', () => {
  it('slugifies city + state', () => {
    expect(slugCityKey('El Paso', 'TX')).toBe('el-paso-tx');
    expect(slugCityKey("Coeur d'Alene", 'ID')).toBe('coeur-d-alene-id');
    expect(slugCityKey('Winston-Salem', 'NC')).toBe('winston-salem-nc');
    expect(slugCityKey(' Austin ', 'tx')).toBe('austin-tx');
  });
});

describe('parseCityFields', () => {
  it('returns null value when no city fields are present', () => {
    expect(parseCityFields({ title: 'x' })).toEqual({ ok: true, value: null });
  });

  it('accepts a consistent triple and normalizes state to uppercase', () => {
    expect(parseCityFields({ city_key: 'el-paso-tx', city: 'El Paso', state: 'tx' }))
      .toEqual({ ok: true, value: { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' } });
  });

  it('treats a lone `city` (no city_key/state) as the SEO-only channel: ok+null', () => {
    expect(parseCityFields({ city: 'El Paso' })).toEqual({ ok: true, value: null });
  });

  it('rejects `state` present without city_key/city', () => {
    expect(parseCityFields({ state: 'TX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
  });

  it('rejects `city_key` present without city/state', () => {
    expect(parseCityFields({ city_key: 'el-paso-tx' })).toEqual({ ok: false, error: 'invalid_city_fields' });
  });

  it('treats `city: null` alone as absent (ok+null)', () => {
    expect(parseCityFields({ city: null })).toEqual({ ok: true, value: null });
  });

  it('rejects a key that does not match slug(city, state)', () => {
    expect(parseCityFields({ city_key: 'austin-tx', city: 'El Paso', state: 'TX' }))
      .toEqual({ ok: false, error: 'invalid_city_key' });
  });

  it('rejects bad shapes', () => {
    expect(parseCityFields({ city_key: 7, city: 'El Paso', state: 'TX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
    expect(parseCityFields({ city_key: 'el-paso-tx', city: '', state: 'TX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
    expect(parseCityFields({ city_key: 'el-paso-txx', city: 'El Paso', state: 'TXX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
    expect(parseCityFields({ city_key: 'el-paso-tx', city: 'E'.repeat(101), state: 'TX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
  });

  it('rejects a city that slugs to empty (non-alphanumeric-only city)', () => {
    expect(parseCityFields({ city_key: '-tx', city: '™', state: 'TX' })).toEqual({ ok: false, error: 'invalid_city_fields' });
  });

  it('treats explicit nulls as absent', () => {
    expect(parseCityFields({ city_key: null, city: null, state: null })).toEqual({ ok: true, value: null });
  });
});

describe('parsePreferredCities', () => {
  const el = { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' };
  const austin = { city_key: 'austin-tx', city: 'Austin', state: 'TX' };

  it('accepts an empty list', () => {
    expect(parsePreferredCities([])).toEqual({ ok: true, value: [] });
  });

  it('accepts up to 10 and dedupes by key', () => {
    expect(parsePreferredCities([el, austin, el])).toEqual({
      ok: true,
      value: [{ ...el, latitude: null, longitude: null }, { ...austin, latitude: null, longitude: null }],
    });
  });

  it('rejects more than 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ city_key: `city-${i}-tx`, city: `City ${i}`, state: 'TX' }));
    expect(parsePreferredCities(many)).toEqual({ ok: false, error: 'too_many_preferred_cities' });
  });

  it('dedupes before enforcing the limit', () => {
    const many = Array.from({ length: 12 }, () => el);
    expect(parsePreferredCities(many)).toEqual({ ok: true, value: [{ ...el, latitude: null, longitude: null }] });
  });

  it('rejects non-arrays and bad items', () => {
    expect(parsePreferredCities('nope' as never)).toEqual({ ok: false, error: 'invalid_preferred_cities' });
    expect(parsePreferredCities([{ city_key: 'austin-tx', city: 'El Paso', state: 'TX' }])).toEqual({ ok: false, error: 'invalid_preferred_cities' });
  });

  it('still rejects a lone-city item (parsePreferredCities requires a full triple per item, unlike parseCityFields)', () => {
    expect(parsePreferredCities([{ city: 'El Paso' }])).toEqual({ ok: false, error: 'invalid_preferred_cities' });
  });
});

describe('parseCityFromLocation', () => {
  it.each([
    ['El Paso, TX', { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }],
    ['El Paso, TX 79912', { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }],
    ['El Paso, tx 79912-1234', { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }],
    ["Coeur d'Alene, ID", { city_key: 'coeur-d-alene-id', city: "Coeur d'Alene", state: 'ID' }],
    ['Winston-Salem, NC', { city_key: 'winston-salem-nc', city: 'Winston-Salem', state: 'NC' }],
    ['  Columbus ,  OH  ', { city_key: 'columbus-oh', city: 'Columbus', state: 'OH' }],
  ])('parses %s', (input, expected) => {
    expect(parseCityFromLocation(input)).toEqual(expected);
  });

  it('normalizes exotic whitespace before matching (NBSP)', () => {
    expect(parseCityFromLocation('El Paso, TX 79912')).toEqual({
      city_key: 'el-paso-tx', city: 'El Paso', state: 'TX',
    });
  });

  it.each([
    ['79912'],                 // bare ZIP
    ['El Paso'],               // no comma
    ['El Paso, Texas'],        // full state name
    ['Near the stadium'],      // free text
    ['123 Main St, El Paso'],  // leading digits
    [''],
  ])('returns null for %s', (input) => {
    expect(parseCityFromLocation(input)).toBeNull();
  });
});

describe('parsePreferredCities coordinates', () => {
  const triple = { city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' };

  it('passes coordinates through when both are valid', () => {
    const res = parsePreferredCities([{ ...triple, latitude: 31.7619, longitude: -106.485 }]);
    expect(res).toEqual({ ok: true, value: [{ ...triple, latitude: 31.7619, longitude: -106.485 }] });
  });

  it('treats null coordinates as absent (legacy GET->PATCH round-trip)', () => {
    const res = parsePreferredCities([{ ...triple, latitude: null, longitude: null }]);
    expect(res).toEqual({ ok: true, value: [{ ...triple, latitude: null, longitude: null }] });
  });

  it('normalizes missing coordinates to null', () => {
    const res = parsePreferredCities([triple]);
    expect(res).toEqual({ ok: true, value: [{ ...triple, latitude: null, longitude: null }] });
  });

  it.each([
    [{ latitude: 31.76 }],                          // one-sided
    [{ latitude: 91, longitude: -106.4 }],          // lat out of range
    [{ latitude: 31.76, longitude: -181 }],         // lon out of range
    [{ latitude: '31.76', longitude: -106.4 }],     // non-number
    [{ latitude: NaN, longitude: -106.4 }],         // non-finite
  ])('rejects invalid coordinate shape %j', (coords) => {
    expect(parsePreferredCities([{ ...triple, ...coords }]))
      .toEqual({ ok: false, error: 'invalid_preferred_cities' });
  });
});
