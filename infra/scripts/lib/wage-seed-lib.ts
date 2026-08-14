/**
 * wage-seed-lib.ts
 *
 * Pure, unit-testable building blocks shared by generate-oews-seed.ts (the
 * dev-time generator) and seed-oews-wages.ts (the operator loader). Nothing
 * in this module touches the filesystem, the network, or a database
 * connection -- that keeps it importable from jest without side effects,
 * unlike scripts/seed-whatsapp-ranked-jobs.ts's `void main()` pattern.
 *
 * Trade -> SOC mapping and TX geography per
 * docs/superpowers/specs/2026-08-12-recommended-pay-design.md. Drywall is
 * SOC 47-2081 ONLY (Luis's decision, no 47-2082 Tapers blend).
 */

import { TRADE_CATEGORIES } from '../../lambda/lib/job-fields';
import { slugCityKey } from '../../lambda/lib/city-fields';

export type WageBearingTrade =
  | 'electrician'
  | 'plumber'
  | 'carpenter'
  | 'concrete'
  | 'painting'
  | 'drywall'
  | 'general_labor';

// 'other' is a valid trade_category (schema CHECK allows it, matching the
// 8-value canonical TRADE_CATEGORIES list) but carries no SOC mapping and
// no benchmark -- excluded here on purpose.
export const TRADED_CATEGORIES_WITH_WAGES: readonly WageBearingTrade[] = [
  'electrician',
  'plumber',
  'carpenter',
  'concrete',
  'painting',
  'drywall',
  'general_labor',
];

// Sanity check at module load: every wage-bearing trade must be one of the
// canonical job-fields categories, and 'other' must stay excluded. This
// throws immediately (not silently) if job-fields.ts ever drops a value
// this module depends on.
for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
  if (!(TRADE_CATEGORIES as readonly string[]).includes(trade)) {
    throw new Error(`wage-seed-lib: '${trade}' is not in job-fields.ts TRADE_CATEGORIES`);
  }
}

export const TRADE_SOC_CODES: Record<WageBearingTrade, string> = {
  electrician: '47-2111',
  plumber: '47-2152',
  carpenter: '47-2031',
  concrete: '47-2051',
  painting: '47-2141',
  drywall: '47-2081',
  general_labor: '47-2061',
};

export type AreaKind = 'metro' | 'nonmetro' | 'state';

export interface AreaDef {
  area_code: string;
  area_label: string;
  area_kind: AreaKind;
}

// The 5 OEWS-published Texas metro areas (May-2025 CBSA definitions).
export const TX_METRO_AREAS: readonly AreaDef[] = [
  { area_code: '12420', area_label: 'Austin', area_kind: 'metro' },
  { area_code: '19100', area_label: 'Dallas-Fort Worth', area_kind: 'metro' },
  { area_code: '26420', area_label: 'Houston', area_kind: 'metro' },
  { area_code: '41700', area_label: 'San Antonio', area_kind: 'metro' },
  { area_code: '21340', area_label: 'El Paso', area_kind: 'metro' },
];

// The 6 OEWS Texas nonmetro regions as of the May-2025 release (real BLS
// AREA codes, verified directly against the downloaded OEWS bulk file --
// see generate-oews-seed.ts's header). NOTE: this is 6 regions, not the "5
// named nonmetro regions (Border, West Texas, Coastal Plains, North Texas,
// Big Thicket)" the recommended-pay design doc describes -- BLS has since
// revised its Texas nonmetro area definitions. "Border" and "Coastal
// Plains" persisted under the same names; "West Texas", "North Texas", and
// "Big Thicket" no longer exist as such and are replaced by "Northwestern",
// "North", "Eastern", and "Hill Country" regions (4 replacing 3 is why the
// count grew from 5 to 6). Reconciled against current reality per CLAUDE.md
// Source Authority -- this is a documented deviation from the design doc,
// not a silent one.
export const TX_NONMETRO_AREAS: readonly AreaDef[] = [
  { area_code: '4800001', area_label: 'Northwestern Region', area_kind: 'nonmetro' },
  { area_code: '4800002', area_label: 'North Region', area_kind: 'nonmetro' },
  { area_code: '4800003', area_label: 'Eastern Region', area_kind: 'nonmetro' },
  { area_code: '4800004', area_label: 'Hill Country Region', area_kind: 'nonmetro' },
  { area_code: '4800005', area_label: 'Border Region', area_kind: 'nonmetro' },
  { area_code: '4800006', area_label: 'Coastal Plains Region', area_kind: 'nonmetro' },
];

// 'TX' (not BLS's raw AREA='48' FIPS code) is this schema's own documented
// convention for the state tier: a reader of pay-reference.ts (T-B2) can
// interpret 'TX' without a FIPS lookup, and it generalizes cleanly if a
// second state ships later ('TX'/'OK', not '48'/'40'). The metro (CBSA) and
// nonmetro area_codes above ARE the real BLS/Census codes because those
// have no more-readable alternative; the state row is different -- 'state'
// is a single, statically-known tier per state, so a readable label loses
// nothing. generate-oews-seed.ts looks up the real OEWS row using BLS's
// actual '48' AREA code internally, then stores it here under 'TX'.
export const TX_STATE_AREA: AreaDef = { area_code: 'TX', area_label: 'Texas', area_kind: 'state' };

export const ALL_TX_AREAS: readonly AreaDef[] = [
  ...TX_METRO_AREAS,
  ...TX_NONMETRO_AREAS,
  TX_STATE_AREA,
];

export interface WageCell {
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
}

/**
 * Structural validation of one wage cell (schema mirrors the migration 071
 * CHECK constraint exactly: p25 > 0 AND p25 <= p50 AND p50 <= p75). Returns
 * null when valid, or a human-readable reason string when not -- never
 * throws, so callers can batch-validate and report every bad row at once.
 */
export function validateWageCell(cell: WageCell): string | null {
  if (!(cell.p25_hourly > 0)) {
    return `p25_hourly must be > 0 (got ${cell.p25_hourly})`;
  }
  if (!(cell.p25_hourly <= cell.p50_hourly)) {
    return `p25_hourly must be <= p50_hourly (got ${cell.p25_hourly} > ${cell.p50_hourly})`;
  }
  if (!(cell.p50_hourly <= cell.p75_hourly)) {
    return `p50_hourly must be <= p75_hourly (got ${cell.p50_hourly} > ${cell.p75_hourly})`;
  }
  return null;
}

export interface ResolvedTier {
  cell: WageCell;
  source_tier: AreaKind;
}

/**
 * Sparse-data fallback: metro -> nonmetro -> state (per the recommended-pay
 * design doc). `cellsByTier` holds only the tiers for which OEWS actually
 * published a (non-suppressed) number for this trade -- a tier absent from
 * the map means BLS suppressed that cell for this trade/geography.
 *
 * A nonmetro-target row does NOT fall back to a metro cell -- metro is a
 * narrower, more specific geography than nonmetro, not a broader one, so
 * "falling back" from nonmetro to metro would substitute an unrelated
 * area's number, not a genuinely broader aggregate. The only valid
 * broadening direction from nonmetro is straight to state.
 *
 * Returns null only if even the state cell is missing for the target's
 * lookup order -- callers must never invent a number in that case.
 */
export function resolveSourceTier(
  targetTier: AreaKind,
  cellsByTier: Partial<Record<AreaKind, WageCell>>,
): ResolvedTier | null {
  const order: readonly AreaKind[] =
    targetTier === 'metro' ? ['metro', 'nonmetro', 'state']
      : targetTier === 'nonmetro' ? ['nonmetro', 'state']
        : ['state'];

  for (const tier of order) {
    const cell = cellsByTier[tier];
    if (cell) {
      return { cell, source_tier: tier };
    }
  }
  return null;
}

/**
 * Re-exports the canonical city_key slug rule (infra/lambda/lib/city-fields.ts
 * #slugCityKey) rather than reimplementing it, so the crosswalk can never
 * drift from the same rule migration 065's backfill and
 * frontend/src/lib/location-search.ts use (see 065's header on why all
 * three must agree).
 */
export function crosswalkCityKey(city: string, state: string): string {
  return slugCityKey(city, state);
}
