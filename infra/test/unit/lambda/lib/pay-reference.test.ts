import { Client } from 'pg';
import {
  isValidTradeCategory,
  isValidCityKey,
  lookupPayReference,
  STATE_AREA_CODE,
} from '../../../../lambda/lib/pay-reference';
import { TX_STATE_AREA } from '../../../../scripts/lib/wage-seed-lib';

describe('pay-reference lib', () => {
  describe('isValidTradeCategory', () => {
    it.each([
      'electrician',
      'plumber',
      'carpenter',
      'concrete',
      'painting',
      'drywall',
      'general_labor',
      'other',
    ])('accepts %s (one of the 8 canonical TRADE_CATEGORIES)', (trade) => {
      expect(isValidTradeCategory(trade)).toBe(true);
    });

    it.each([
      undefined,
      null,
      '',
      'welder',
      'Electrician',
      123,
      ['electrician'],
    ])('rejects %p', (trade) => {
      expect(isValidTradeCategory(trade)).toBe(false);
    });
  });

  describe('isValidCityKey', () => {
    it.each([
      'austin-tx',
      'san-antonio-tx',
      'a',
      '123-tx',
      'a'.repeat(120),
    ])('accepts %s', (cityKey) => {
      expect(isValidCityKey(cityKey)).toBe(true);
    });

    it.each([
      undefined,
      null,
      '',
      'Austin-TX', // uppercase not allowed
      'austin tx', // space not allowed
      "austin'; DROP TABLE city_cbsa_crosswalk; --",
      '<script>alert(1)</script>-tx',
      'a'.repeat(121), // over the 120-char cap
      123,
    ])('rejects %p', (cityKey) => {
      expect(isValidCityKey(cityKey)).toBe(false);
    });
  });

  describe('state area_code stays in sync with T-B1 wage-seed-lib.ts', () => {
    it('STATE_AREA_CODE matches wage-seed-lib.ts TX_STATE_AREA.area_code exactly', () => {
      // Guards against silent drift between the two independently-maintained
      // constants -- see migration 071's header: the state tier's area_code
      // is the literal string 'TX', not BLS's raw '48' FIPS code.
      expect(STATE_AREA_CODE).toBe(TX_STATE_AREA.area_code);
      expect(STATE_AREA_CODE).toBe('TX');
    });
  });

  describe('lookupPayReference', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = { query: jest.fn() } as unknown as Client;
    });

    it('returns the metro row when the crosswalk hits and wage_references has a row at that area_code', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM city_cbsa_crosswalk')) {
          return Promise.resolve({ rows: [{ area_code: '12420' }] });
        }
        if (sql.includes('FROM wage_references')) {
          return Promise.resolve({
            rows: [{
              trade_category: 'electrician',
              p25_hourly: '22.97',
              p50_hourly: '29.03',
              p75_hourly: '35.25',
              area_kind: 'metro',
              area_label: 'Austin',
              source_tier: 'metro',
              data_vintage: 'May 2025',
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await lookupPayReference(mockClient, 'electrician', 'austin-tx');

      expect(result).toEqual({
        trade_category: 'electrician',
        p25_hourly: 22.97,
        p50_hourly: 29.03,
        p75_hourly: 35.25,
        area_kind: 'metro',
        area_label: 'Austin',
        source_tier: 'metro',
        data_vintage: 'May 2025',
      });
      // numbers, not strings
      expect(typeof result?.p25_hourly).toBe('number');
      expect(typeof result?.p50_hourly).toBe('number');
      expect(typeof result?.p75_hourly).toBe('number');
    });

    it('falls back to the state row when the crosswalk has no hit for the city_key', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql.includes('FROM city_cbsa_crosswalk')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM wage_references')) {
          return Promise.resolve({
            rows: [{
              trade_category: 'electrician',
              p25_hourly: '22.44',
              p50_hourly: '28.16',
              p75_hourly: '34.20',
              area_kind: 'state',
              area_label: 'Texas',
              source_tier: 'state',
              data_vintage: 'May 2025',
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await lookupPayReference(mockClient, 'electrician', 'smalltown-tx');

      expect(result).not.toBeNull();
      expect(result?.area_kind).toBe('state');
      expect(result?.p50_hourly).toBe(28.16);

      const wageCall = mockClient.query.mock.calls.find(([sql]: [string]) => sql.includes('FROM wage_references'));
      expect(wageCall?.[1]).toEqual(['electrician', STATE_AREA_CODE]);
    });

    it('falls back to the state row when the crosswalk hits but wage_references has no row at that area_code', async () => {
      mockClient.query.mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('FROM city_cbsa_crosswalk')) {
          return Promise.resolve({ rows: [{ area_code: '4800001' }] }); // nonmetro, unreachable
        }
        if (sql.includes('FROM wage_references') && (params as string[])[1] === '4800001') {
          return Promise.resolve({ rows: [] }); // no metro-tier row exists at this area_code
        }
        if (sql.includes('FROM wage_references') && (params as string[])[1] === STATE_AREA_CODE) {
          return Promise.resolve({
            rows: [{
              trade_category: 'plumber',
              p25_hourly: '20.00',
              p50_hourly: '25.00',
              p75_hourly: '30.00',
              area_kind: 'state',
              area_label: 'Texas',
              source_tier: 'state',
              data_vintage: 'May 2025',
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await lookupPayReference(mockClient, 'plumber', 'some-nonmetro-city-tx');
      expect(result?.area_kind).toBe('state');
    });

    it('returns null when neither the crosswalk-resolved area nor the state row has a benchmark', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await lookupPayReference(mockClient, 'electrician', 'nowhere-tx');
      expect(result).toBeNull();
    });

    it('uses parameterized queries for both the crosswalk and wage lookups (no string interpolation)', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      await lookupPayReference(mockClient, 'electrician', "'; DROP TABLE city_cbsa_crosswalk; --");

      for (const [sql, params] of mockClient.query.mock.calls) {
        expect(sql).not.toContain('DROP TABLE');
        expect(Array.isArray(params)).toBe(true);
      }
    });
  });
});
