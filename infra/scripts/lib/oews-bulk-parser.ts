/**
 * oews-bulk-parser.ts
 *
 * Pure parser for the BLS OEWS "all data" bulk file (verified against the
 * real May-2025 release, oesm25all/all_data_M_2025.xlsx, downloaded
 * 2026-08-13 -- see generate-oews-seed.ts's header for the URL/hash and the
 * full story of how it was fetched). Column layout (position-based, header
 * row confirmed byte-for-byte against the real file):
 *
 *   AREA, AREA_TITLE, AREA_TYPE, PRIM_STATE, NAICS, NAICS_TITLE, I_GROUP,
 *   OWN_CODE, OCC_CODE, OCC_TITLE, O_GROUP, TOT_EMP, EMP_PRSE, JOBS_1000,
 *   LOC_QUOTIENT, PCT_TOTAL, PCT_RPT, H_MEAN, A_MEAN, MEAN_PRSE, H_PCT10,
 *   H_PCT25, H_MEDIAN, H_PCT75, H_PCT90, A_PCT10, A_PCT25, A_MEDIAN,
 *   A_PCT75, A_PCT90, ANNUAL, HOURLY
 *
 * AREA_TYPE: 2=state, 4=metropolitan statistical area, 6=nonmetropolitan
 * area (also verified against the real file's TX rows).
 *
 * Takes an already-parsed 2D sheet array (as `XLSX.utils.sheet_to_json(ws,
 * { header: 1 })` returns) rather than touching `xlsx` itself, so this is
 * importable from jest with a small hand-built fixture -- no dependency on
 * the real 80MB file being present, and no risk of the test suite trying to
 * load it.
 */

import { WageCell, validateWageCell } from './wage-seed-lib';

const AREA_COL = 0;
const OCC_CODE_COL = 8;
const H_PCT25_COL = 21;
const H_MEDIAN_COL = 22;
const H_PCT75_COL = 23;

export function oewsCellKey(areaCode: string, occCode: string): string {
  return `${areaCode}|${occCode}`;
}

/** Parses a BLS wage cell value; returns null for suppressed/blank/non-numeric markers ('*', '**', '#', ''). */
function parseWageNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === '**' || trimmed === '#') {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extracts hourly wage cells for the given target occupation/area codes,
 * keyed by oewsCellKey(areaCode, occCode). Rows for any other occupation or
 * area are ignored. A row with a suppressed, blank, or otherwise
 * unparseable percentile is dropped (never coerced to 0 or guessed). A row
 * whose three percentiles do not satisfy p25 <= p50 <= p75 (and p25 > 0) is
 * also dropped rather than trusted blindly -- this is real government data,
 * but a full 413k-row bulk file is exactly the kind of input where a single
 * malformed row must not corrupt the seed silently.
 */
export function parseOewsBulkRows(
  rows: readonly unknown[][],
  targetOccCodes: ReadonlySet<string>,
  targetAreaCodes: ReadonlySet<string>,
): Map<string, WageCell> {
  const out = new Map<string, WageCell>();
  // rows[0] is the header; data starts at rows[1]. This parser is
  // position-based (not header-name lookup) because the position was
  // verified directly against the real file -- see this module's header.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) {
      continue;
    }
    const areaCode = row[AREA_COL];
    const occCode = row[OCC_CODE_COL];
    if (typeof areaCode !== 'string' || typeof occCode !== 'string') {
      continue;
    }
    if (!targetAreaCodes.has(areaCode) || !targetOccCodes.has(occCode)) {
      continue;
    }
    const p25 = parseWageNumber(row[H_PCT25_COL]);
    const p50 = parseWageNumber(row[H_MEDIAN_COL]);
    const p75 = parseWageNumber(row[H_PCT75_COL]);
    if (p25 === null || p50 === null || p75 === null) {
      continue; // suppressed cell -- never invented
    }
    const cell: WageCell = { p25_hourly: p25, p50_hourly: p50, p75_hourly: p75 };
    if (validateWageCell(cell) !== null) {
      continue; // malformed row in a 413k-row file -- drop, don't trust blindly
    }
    out.set(oewsCellKey(areaCode, occCode), cell);
  }
  return out;
}
