import { slugCityKey, parseCityFields, parsePreferredCities } from '../../../../lambda/lib/city-fields';

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

  it('rejects a partial triple', () => {
    expect(parseCityFields({ city: 'El Paso' })).toEqual({ ok: false, error: 'invalid_city_fields' });
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
    expect(parsePreferredCities([el, austin, el])).toEqual({ ok: true, value: [el, austin] });
  });

  it('rejects more than 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ city_key: `city-${i}-tx`, city: `City ${i}`, state: 'TX' }));
    expect(parsePreferredCities(many)).toEqual({ ok: false, error: 'too_many_preferred_cities' });
  });

  it('dedupes before enforcing the limit', () => {
    const many = Array.from({ length: 12 }, () => el);
    expect(parsePreferredCities(many)).toEqual({ ok: true, value: [el] });
  });

  it('rejects non-arrays and bad items', () => {
    expect(parsePreferredCities('nope' as never)).toEqual({ ok: false, error: 'invalid_preferred_cities' });
    expect(parsePreferredCities([{ city_key: 'austin-tx', city: 'El Paso', state: 'TX' }])).toEqual({ ok: false, error: 'invalid_preferred_cities' });
  });
});
