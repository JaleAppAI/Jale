/**
 * B-4 data-sanity suite: static assertions against the checked-in
 * infra/scripts/data/oews-tx-seed.json (no DB, no network). Complements
 * wage-references.integration.test.ts, which checks the same file's rows
 * actually load and enforce their constraints against real Postgres.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TRADED_CATEGORIES_WITH_WAGES, TX_METRO_AREAS, validateWageCell } from '../../../scripts/lib/wage-seed-lib';

const seedPath = path.join(__dirname, '..', '..', '..', 'scripts', 'data', 'oews-tx-seed.json');

interface WageReferenceRow {
  trade_category: string;
  area_code: string;
  area_kind: 'metro' | 'nonmetro' | 'state';
  area_label: string;
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
  source_tier: 'metro' | 'nonmetro' | 'state';
  data_vintage: string;
}

interface CrosswalkRow {
  city_key: string;
  city: string;
  state: string;
  county_fips: string | null;
  area_code: string;
  area_kind: 'metro' | 'nonmetro';
}

interface SeedFile {
  placeholder: boolean;
  data_vintage: string;
  provenance: Record<string, unknown>;
  wage_references: WageReferenceRow[];
  city_cbsa_crosswalk: CrosswalkRow[];
}

function readSeed(): SeedFile {
  return JSON.parse(fs.readFileSync(seedPath, 'utf8'));
}

describe('oews-tx-seed.json: structural sanity (B-4)', () => {
  it('the checked-in seed is real data, not the placeholder fallback', () => {
    const seed = readSeed();
    // This is a positive assertion, not a tripwire: it documents that the
    // real BLS OEWS download/parse path succeeded for this checked-in
    // file. If a future regeneration run falls back to placeholder data
    // (network/tooling failure), this test goes red -- on purpose, so
    // nobody commits placeholder wages without noticing.
    expect(seed.placeholder).toBe(false);
    expect(seed.provenance.oews_bulk_file).toMatchObject({ status: 'downloaded' });
  });

  it('every wage_references row has p25 <= p50 <= p75, all > 0', () => {
    const seed = readSeed();
    expect(seed.wage_references.length).toBeGreaterThan(0);
    for (const row of seed.wage_references) {
      const invalid = validateWageCell(row);
      expect({ row, invalid }).toEqual({ row, invalid: null });
    }
  });

  it("every row's data_vintage is 'May 2025'", () => {
    const seed = readSeed();
    for (const row of seed.wage_references) {
      expect(row.data_vintage).toBe('May 2025');
    }
    expect(seed.data_vintage).toBe('May 2025');
  });

  it('each of the 7 wage-bearing trades has at least one state-tier row', () => {
    const seed = readSeed();
    for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
      const stateRows = seed.wage_references.filter((r) => r.trade_category === trade && r.area_kind === 'state');
      expect(stateRows.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('electrician has a row for all 5 TX metro areas', () => {
    const seed = readSeed();
    const electricianMetroAreaCodes = seed.wage_references
      .filter((r) => r.trade_category === 'electrician' && r.area_kind === 'metro')
      .map((r) => r.area_code)
      .sort();
    expect(electricianMetroAreaCodes).toEqual(TX_METRO_AREAS.map((a) => a.area_code).sort());
  });

  it('no trade_category outside the 7 wage-bearing trades appears (no "other" row)', () => {
    const seed = readSeed();
    const trades = new Set(seed.wage_references.map((r) => r.trade_category));
    expect(trades.has('other')).toBe(false);
    for (const trade of trades) {
      expect(TRADED_CATEGORIES_WITH_WAGES).toContain(trade);
    }
  });

  it('pins the documented source_tier/area_kind asymmetry: drywall in a nonmetro region BLS suppressed falls back to the state tier', () => {
    // Real, verified BLS suppression: Drywall and Ceiling Tile Installers
    // has no published cell for the Northwestern Region of Texas (area
    // 4800001) in the May-2025 release, so this row must be backed by the
    // statewide figure -- area_kind stays 'nonmetro' (that's still what
    // area 4800001 IS), but source_tier reads 'state' (that's where the
    // NUMBERS actually came from). This is the subtlest part of the schema
    // (two columns sharing the same enum for different reasons) and the
    // thing most likely to be misread by whoever builds the lookup
    // endpoint, so it is pinned here explicitly rather than only covered
    // by the generic "some row has area_kind != source_tier" case.
    const seed = readSeed();
    const row = seed.wage_references.find((r) => r.trade_category === 'drywall' && r.area_code === '4800001');
    expect(row).toBeDefined();
    expect(row?.area_kind).toBe('nonmetro');
    expect(row?.source_tier).toBe('state');

    const stateDrywallRow = seed.wage_references.find((r) => r.trade_category === 'drywall' && r.area_kind === 'state');
    expect(stateDrywallRow).toBeDefined();
    expect(row?.p25_hourly).toBe(stateDrywallRow?.p25_hourly);
    expect(row?.p50_hourly).toBe(stateDrywallRow?.p50_hourly);
    expect(row?.p75_hourly).toBe(stateDrywallRow?.p75_hourly);
  });

  it('at least one row per trade has source_tier === area_kind (the common, non-fallback case)', () => {
    const seed = readSeed();
    for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
      const natural = seed.wage_references.some((r) => r.trade_category === trade && r.source_tier === r.area_kind);
      expect(natural).toBe(true);
    }
  });

  it('PRIMARY KEY (trade_category, area_code) has no duplicates in the checked-in data', () => {
    const seed = readSeed();
    const keys = seed.wage_references.map((r) => `${r.trade_category}|${r.area_code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('oews-tx-seed.json: crosswalk sanity', () => {
  it('every crosswalk row has a non-empty city_key matching the slug rule and a metro area_code', () => {
    const seed = readSeed();
    expect(seed.city_cbsa_crosswalk.length).toBeGreaterThan(0);
    const metroCodes = new Set(TX_METRO_AREAS.map((a) => a.area_code));
    for (const row of seed.city_cbsa_crosswalk) {
      expect(row.city_key).toMatch(/^[a-z0-9-]+-tx$/);
      expect(row.area_kind).toBe('metro');
      expect(metroCodes.has(row.area_code)).toBe(true);
    }
  });

  it('city_key values are unique (matches the PRIMARY KEY)', () => {
    const seed = readSeed();
    const keys = seed.city_cbsa_crosswalk.map((r) => r.city_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('includes Austin, Dallas, Houston, San Antonio, and El Paso (spot-check of principal cities)', () => {
    const seed = readSeed();
    const cityKeys = new Set(seed.city_cbsa_crosswalk.map((r) => r.city_key));
    for (const key of ['austin-tx', 'dallas-tx', 'houston-tx', 'san-antonio-tx', 'el-paso-tx']) {
      expect(cityKeys.has(key)).toBe(true);
    }
  });
});
