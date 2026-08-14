import type { Client, PoolClient } from 'pg';
import { TRADE_CATEGORIES } from './job-fields';

/**
 * Recommended-pay lookup (Feature B / T-B2) against the OEWS wage reference
 * tables added by migration 071 (wage_references, city_cbsa_crosswalk) and
 * populated by T-B1's infra/scripts/seed-oews-wages.ts from
 * infra/scripts/data/oews-tx-seed.json.
 *
 * Lookup order, per migration 071's header and the recommended-pay design:
 *   1. Resolve city_key -> area_code via city_cbsa_crosswalk. Today the
 *      crosswalk only maps principal cities of the 5 target Texas MSAs to
 *      metro area_codes -- nonmetro area_codes exist in wage_references but
 *      are never the target of a crosswalk row (see migration 071's header),
 *      so in practice this step either resolves to a metro area_code or
 *      finds nothing.
 *   2. If the crosswalk resolved an area_code AND wage_references has a row
 *      for (trade, that area_code), return it.
 *   3. Otherwise (no crosswalk hit, OR a crosswalk hit whose area_code has no
 *      matching wage_references row) fall back to the state row:
 *      wage_references at (trade, area_code = STATE_AREA_CODE).
 *   4. If neither exists, return null -- the caller (lambda/api/pay-reference.ts)
 *      turns that into a 404 { error: 'no_reference' }. This function never
 *      invents a number.
 *
 * 'other' is a valid trade_category (job-fields.ts TRADE_CATEGORIES) but
 * carries zero wage_references rows by design (see T-B1's wage-seed-lib.ts
 * TRADED_CATEGORIES_WITH_WAGES, which excludes it) -- the handler
 * short-circuits on 'other' before calling this function, but calling this
 * function with trade='other' anyway is harmless: both queries below just
 * find zero rows and this returns null.
 */

// Mirrors T-B1's infra/scripts/lib/wage-seed-lib.ts TX_STATE_AREA.area_code
// exactly -- the literal string 'TX', NOT BLS's raw '48' FIPS code (see
// migration 071's header for why). Kept as its own constant here rather than
// importing infra/scripts/lib/wage-seed-lib.ts into lambda code, since lambda
// code does not otherwise depend on the infra/scripts tree (scripts import
// from lambda/lib, never the reverse). The lib test file cross-checks this
// constant against wage-seed-lib.ts's TX_STATE_AREA.area_code directly so the
// two cannot silently drift apart.
export const STATE_AREA_CODE = 'TX';

export type TradeCategory = (typeof TRADE_CATEGORIES)[number];

/** True iff `value` is a string and one of the 8 canonical TRADE_CATEGORIES (job-fields.ts). */
export function isValidTradeCategory(value: unknown): value is TradeCategory {
  return typeof value === 'string' && (TRADE_CATEGORIES as readonly string[]).includes(value);
}

// Lowercase alphanumeric-hyphen, capped at 120 chars -- mirrors the real
// city_key shape produced by city-fields.ts's slugCityKey (e.g. 'austin-tx').
// This is a defensive input gate, not a security boundary: city_key always
// reaches Postgres through a parameterized query (see lookupPayReference
// below), so a value that fails this check would just find zero rows either
// way. Rejecting it here up front avoids a wasted round trip and keeps the
// 400 error body from ever needing to explain a SQL-level rejection (e.g. an
// embedded NUL byte, which Postgres text columns reject outright).
const CITY_KEY_RE = /^[a-z0-9-]{1,120}$/;

/** True iff `value` is a string matching the lowercase alnum-hyphen city_key slug shape, <=120 chars. */
export function isValidCityKey(value: unknown): value is string {
  return typeof value === 'string' && CITY_KEY_RE.test(value);
}

export type AreaKind = 'metro' | 'nonmetro' | 'state';

export interface PayReferenceResult {
  trade_category: string;
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
  area_kind: AreaKind;
  area_label: string;
  source_tier: AreaKind;
  data_vintage: string;
}

interface WageReferenceRow {
  trade_category: string;
  // NUMERIC columns come back from node-postgres as strings by default (no
  // custom type parser is registered for OID 1700) -- cast explicitly in
  // toResult() below so callers always get real numbers, never strings.
  p25_hourly: string | number;
  p50_hourly: string | number;
  p75_hourly: string | number;
  area_kind: AreaKind;
  area_label: string;
  source_tier: AreaKind;
  data_vintage: string;
}

const WAGE_REFERENCE_COLUMNS = `trade_category, p25_hourly, p50_hourly, p75_hourly, area_kind, area_label, source_tier, data_vintage`;

function toResult(row: WageReferenceRow): PayReferenceResult {
  return {
    trade_category: row.trade_category,
    p25_hourly: Number(row.p25_hourly),
    p50_hourly: Number(row.p50_hourly),
    p75_hourly: Number(row.p75_hourly),
    area_kind: row.area_kind,
    area_label: row.area_label,
    source_tier: row.source_tier,
    data_vintage: row.data_vintage,
  };
}

async function fetchWageRow(
  client: Client | PoolClient,
  trade: string,
  areaCode: string,
): Promise<WageReferenceRow | null> {
  const result = await client.query<WageReferenceRow>(
    `SELECT ${WAGE_REFERENCE_COLUMNS} FROM wage_references WHERE trade_category = $1 AND area_code = $2`,
    [trade, areaCode],
  );
  return result.rows[0] ?? null;
}

/**
 * Looks up the recommended-pay benchmark for (trade, city_key). Returns null
 * when there is no benchmark to show for this pair at any tier -- callers
 * must treat that as "no reference available", never invent a number.
 *
 * `client` must be a live connection/transaction (Client or PoolClient, same
 * union lib/db.ts's setRlsContext accepts). All SQL is parameterized -- safe
 * against a hostile city_key even though isValidCityKey() should already
 * have rejected most malformed input before this is called.
 */
export async function lookupPayReference(
  client: Client | PoolClient,
  trade: string,
  cityKey: string,
): Promise<PayReferenceResult | null> {
  const crosswalkResult = await client.query<{ area_code: string }>(
    `SELECT area_code FROM city_cbsa_crosswalk WHERE city_key = $1`,
    [cityKey],
  );
  const crosswalkAreaCode = crosswalkResult.rows[0]?.area_code;

  if (crosswalkAreaCode) {
    const hitRow = await fetchWageRow(client, trade, crosswalkAreaCode);
    if (hitRow) return toResult(hitRow);
  }

  const stateRow = await fetchWageRow(client, trade, STATE_AREA_CODE);
  return stateRow ? toResult(stateRow) : null;
}
