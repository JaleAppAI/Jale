import { describe, it, expect } from 'vitest';
import { searchLocations, slugCityKey, type LocationRecord } from '@/lib/location-search';

const RECORDS: LocationRecord[] = [
  { zip: '78701', city: 'Austin', state: 'TX', lat: 30.27, lon: -97.74, pop: 5000 },
  { zip: '78702', city: 'Austin', state: 'TX', lat: 30.26, lon: -97.71, pop: 40000 },
  { zip: '78660', city: 'Pflugerville', state: 'TX', lat: 30.44, lon: -97.62, pop: 60000 },
  { zip: '79901', city: 'El Paso', state: 'TX', lat: 31.76, lon: -106.48, pop: 12000 },
  { zip: '30301', city: 'Atlanta', state: 'GA', lat: 33.75, lon: -84.39, pop: 20000 },
  { zip: '99501', city: 'Anchorage', state: 'AK', lat: 61.21, lon: -149.9, pop: 30000 },
  { zip: '62701', city: 'Springfield', state: 'IL', lat: 39.8, lon: -89.64, pop: 114000 },
  { zip: '65801', city: 'Springfield', state: 'MO', lat: 37.21, lon: -93.29, pop: 169000 },
];

// Isolated from RECORDS above: 'Espanola' contains the substring 'an', which
// would otherwise pollute the shared-fixture 'an' query test.
const ACCENT_RECORDS: LocationRecord[] = [
  { zip: '87532', city: 'Espanola', state: 'NM', lat: 36.0, lon: -106.08, pop: 10000 },
];

describe('slugCityKey', () => {
  // Mirrors infra/lambda/lib/city-fields.ts and the migration 061 backfill — keep in sync.
  it('matches the canonical rule', () => {
    expect(slugCityKey('El Paso', 'TX')).toBe('el-paso-tx');
    expect(slugCityKey("Coeur d'Alene", 'ID')).toBe('coeur-d-alene-id');
    expect(slugCityKey('Winston-Salem', 'NC')).toBe('winston-salem-nc');
    expect(slugCityKey(' Austin ', 'tx')).toBe('austin-tx');
  });

  it('folds diacritics to ASCII before slugging', () => {
    expect(slugCityKey('Bayamón', 'PR')).toBe('bayamon-pr');
    expect(slugCityKey('Española', 'NM')).toBe('espanola-nm');
    expect(slugCityKey('El Paso', 'TX')).toBe('el-paso-tx');
  });
});

describe('searchLocations', () => {
  it('returns [] for empty/whitespace query', () => {
    expect(searchLocations('', RECORDS)).toEqual([]);
    expect(searchLocations('   ', RECORDS)).toEqual([]);
  });

  it('matches ZIP by prefix with cityKey and geocoded_zip source', () => {
    const out = searchLocations('787', RECORDS);
    expect(out.map((s) => s.zip)).toEqual(['78701', '78702']);
    expect(out[0]).toMatchObject({
      label: 'Austin, TX 78701',
      cityKey: 'austin-tx',
      city: 'Austin',
      state: 'TX',
      latitude: 30.27,
      longitude: -97.74,
      source: 'geocoded_zip',
    });
  });

  it('matches city names, prefix before contains, and dedupes by city+state', () => {
    const out = searchLocations('an', RECORDS);
    expect(out.map((s) => s.city)).toEqual(['Anchorage', 'Atlanta']);
    expect(out.every((s) => s.source === 'geocoded_address')).toBe(true);
    expect(out[0]).toMatchObject({ label: 'Anchorage, AK', cityKey: 'anchorage-ak' });
  });

  it('collapses multiple ZIPs of one city to a single highest-population entry', () => {
    const out = searchLocations('Austin', RECORDS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ city: 'Austin', state: 'TX', zip: '78702', label: 'Austin, TX', cityKey: 'austin-tx' });
  });

  it('respects the limit', () => {
    expect(searchLocations('7', RECORDS, 1)).toHaveLength(1);
  });

  it('returns [] for a query with no matches', () => {
    expect(searchLocations('zzz-no-such-city', RECORDS)).toEqual([]);
  });

  it('dedupe key includes state, so same-named cities in different states both appear', () => {
    const out = searchLocations('Springfield', RECORDS);
    expect(out.map((s) => s.state).sort()).toEqual(['IL', 'MO']);
  });

  it('folds diacritics on the query so accented searches match ASCII dataset cities', () => {
    const out = searchLocations('Española', ACCENT_RECORDS);
    expect(out.map((s) => s.city)).toEqual(['Espanola']);
    expect(out[0]).toMatchObject({ cityKey: 'espanola-nm' });
  });
});
