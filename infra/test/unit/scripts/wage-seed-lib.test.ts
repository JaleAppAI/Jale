import {
  TRADE_SOC_CODES,
  TRADED_CATEGORIES_WITH_WAGES,
  TX_METRO_AREAS,
  TX_NONMETRO_AREAS,
  TX_STATE_AREA,
  ALL_TX_AREAS,
  validateWageCell,
  resolveSourceTier,
  crosswalkCityKey,
} from '../../../scripts/lib/wage-seed-lib';
import { TRADE_CATEGORIES } from '../../../lambda/lib/job-fields';

describe('wage-seed-lib: trade/area constants', () => {
  it('maps exactly the 7 wage-bearing trades to their SOC codes (excludes other)', () => {
    expect(TRADED_CATEGORIES_WITH_WAGES).toEqual([
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor',
    ]);
    // Every wage-bearing trade must also be one of the 8 canonical job-fields trades.
    for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
      expect(TRADE_CATEGORIES).toContain(trade);
    }
    expect(TRADE_CATEGORIES).toContain('other');
    expect(TRADED_CATEGORIES_WITH_WAGES).not.toContain('other');

    expect(TRADE_SOC_CODES.electrician).toBe('47-2111');
    expect(TRADE_SOC_CODES.plumber).toBe('47-2152');
    expect(TRADE_SOC_CODES.carpenter).toBe('47-2031');
    expect(TRADE_SOC_CODES.concrete).toBe('47-2051');
    expect(TRADE_SOC_CODES.painting).toBe('47-2141');
    expect(TRADE_SOC_CODES.drywall).toBe('47-2081');
    expect(TRADE_SOC_CODES.general_labor).toBe('47-2061');
  });

  it('defines exactly 5 TX metro areas with the given CBSA codes', () => {
    expect(TX_METRO_AREAS).toHaveLength(5);
    const codes = TX_METRO_AREAS.map((a) => a.area_code).sort();
    expect(codes).toEqual(['12420', '19100', '21340', '26420', '41700']);
    for (const area of TX_METRO_AREAS) {
      expect(area.area_kind).toBe('metro');
    }
  });

  it('defines exactly 6 TX nonmetro areas with real BLS area codes (verified against the May-2025 bulk file)', () => {
    // 6, not the recommended-pay design doc's stated 5 -- BLS revised its
    // Texas nonmetro area definitions; see this constant's header comment
    // for the reconciliation.
    expect(TX_NONMETRO_AREAS).toHaveLength(6);
    const codes = TX_NONMETRO_AREAS.map((a) => a.area_code).sort();
    expect(codes).toEqual(['4800001', '4800002', '4800003', '4800004', '4800005', '4800006']);
    for (const area of TX_NONMETRO_AREAS) {
      expect(area.area_kind).toBe('nonmetro');
    }
  });

  it('defines exactly one TX statewide area using the schema\'s readable "TX" convention (not BLS\'s raw FIPS code)', () => {
    expect(TX_STATE_AREA.area_kind).toBe('state');
    expect(TX_STATE_AREA.area_code).toBe('TX');
  });

  it('ALL_TX_AREAS is the union of metro + nonmetro + state (12 areas)', () => {
    expect(ALL_TX_AREAS).toHaveLength(12);
  });
});

describe('wage-seed-lib: validateWageCell', () => {
  it('accepts a strictly increasing, positive cell', () => {
    expect(validateWageCell({ p25_hourly: 20, p50_hourly: 25, p75_hourly: 30 })).toBeNull();
  });

  it('accepts the boundary case p25 === p50 === p75', () => {
    expect(validateWageCell({ p25_hourly: 25, p50_hourly: 25, p75_hourly: 25 })).toBeNull();
  });

  it('rejects p25 > p50', () => {
    expect(validateWageCell({ p25_hourly: 30, p50_hourly: 25, p75_hourly: 35 })).toMatch(/p25_hourly/);
  });

  it('rejects p50 > p75', () => {
    expect(validateWageCell({ p25_hourly: 20, p50_hourly: 35, p75_hourly: 30 })).toMatch(/p50_hourly/);
  });

  it('rejects p25 <= 0', () => {
    expect(validateWageCell({ p25_hourly: 0, p50_hourly: 10, p75_hourly: 20 })).toMatch(/p25_hourly/);
    expect(validateWageCell({ p25_hourly: -5, p50_hourly: 10, p75_hourly: 20 })).toMatch(/p25_hourly/);
  });
});

describe('wage-seed-lib: resolveSourceTier (metro -> nonmetro -> state fallback)', () => {
  const metroCell = { p25_hourly: 22, p50_hourly: 28, p75_hourly: 36 };
  const nonmetroCell = { p25_hourly: 18, p50_hourly: 23, p75_hourly: 29 };
  const stateCell = { p25_hourly: 17, p50_hourly: 21, p75_hourly: 27 };

  it('a metro-target row uses its own metro cell when present', () => {
    const result = resolveSourceTier('metro', { metro: metroCell, nonmetro: nonmetroCell, state: stateCell });
    expect(result).toEqual({ cell: metroCell, source_tier: 'metro' });
  });

  it('a metro-target row falls back to nonmetro when the metro cell is suppressed', () => {
    const result = resolveSourceTier('metro', { nonmetro: nonmetroCell, state: stateCell });
    expect(result).toEqual({ cell: nonmetroCell, source_tier: 'nonmetro' });
  });

  it('a metro-target row falls back all the way to state when both metro and nonmetro are suppressed', () => {
    const result = resolveSourceTier('metro', { state: stateCell });
    expect(result).toEqual({ cell: stateCell, source_tier: 'state' });
  });

  it('a nonmetro-target row never falls back to a metro cell (only nonmetro -> state)', () => {
    const result = resolveSourceTier('nonmetro', { metro: metroCell, state: stateCell });
    expect(result).toEqual({ cell: stateCell, source_tier: 'state' });
  });

  it('a state-target row has nowhere to fall back to -- returns null if even state is missing', () => {
    expect(resolveSourceTier('state', {})).toBeNull();
    expect(resolveSourceTier('state', { metro: metroCell, nonmetro: nonmetroCell })).toBeNull();
  });

  it('returns null (never invents a number) when every tier up to and including the target is missing', () => {
    expect(resolveSourceTier('metro', {})).toBeNull();
  });
});

describe('wage-seed-lib: crosswalkCityKey (must match infra/lambda/lib/city-fields.ts#slugCityKey)', () => {
  it('slugs a simple city/state pair', () => {
    expect(crosswalkCityKey('Austin', 'TX')).toBe('austin-tx');
  });

  it('collapses punctuation and hyphenates multi-word cities', () => {
    expect(crosswalkCityKey('San Antonio', 'TX')).toBe('san-antonio-tx');
    expect(crosswalkCityKey('El Paso', 'TX')).toBe('el-paso-tx');
  });

  it('matches the documented apostrophe/hyphen edge cases from migration 065', () => {
    expect(crosswalkCityKey("Coeur d'Alene", 'ID')).toBe('coeur-d-alene-id');
    expect(crosswalkCityKey('Winston-Salem', 'NC')).toBe('winston-salem-nc');
  });
});
