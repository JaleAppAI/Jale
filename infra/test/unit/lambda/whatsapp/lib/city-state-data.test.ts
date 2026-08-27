import { UNAMBIGUOUS_CITY_TO_STATE } from '../../../../../lambda/whatsapp/lib/city-state-data';

describe('UNAMBIGUOUS_CITY_TO_STATE', () => {
  it('maps well-known single-state cities', () => {
    expect(UNAMBIGUOUS_CITY_TO_STATE['el paso']).toBe('TX');
    expect(UNAMBIGUOUS_CITY_TO_STATE['albuquerque']).toBe('NM');
    expect(UNAMBIGUOUS_CITY_TO_STATE['philadelphia']).toBe('PA');
  });
  it('excludes ambiguous city names', () => {
    expect(UNAMBIGUOUS_CITY_TO_STATE['springfield']).toBeUndefined();
    expect(UNAMBIGUOUS_CITY_TO_STATE['columbus']).toBeUndefined();
  });
  it('keys are normalized (lowercase, unaccented, no periods)', () => {
    for (const key of Object.keys(UNAMBIGUOUS_CITY_TO_STATE)) {
      expect(key).toBe(key.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim());
    }
  });
  it('values are 2-letter USPS abbreviations', () => {
    for (const v of Object.values(UNAMBIGUOUS_CITY_TO_STATE)) expect(v).toMatch(/^[A-Z]{2}$/);
  });
});
