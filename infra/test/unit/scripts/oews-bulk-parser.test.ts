import { parseOewsBulkRows, oewsCellKey } from '../../../scripts/lib/oews-bulk-parser';

// Fixture header matches the REAL BLS OEWS "all data" bulk file column
// layout verified directly against the downloaded May-2025 file
// (oesm25all/all_data_M_2025.xlsx) on 2026-08-13.
const HEADER = [
  'AREA', 'AREA_TITLE', 'AREA_TYPE', 'PRIM_STATE', 'NAICS', 'NAICS_TITLE',
  'I_GROUP', 'OWN_CODE', 'OCC_CODE', 'OCC_TITLE', 'O_GROUP', 'TOT_EMP',
  'EMP_PRSE', 'JOBS_1000', 'LOC_QUOTIENT', 'PCT_TOTAL', 'PCT_RPT', 'H_MEAN',
  'A_MEAN', 'MEAN_PRSE', 'H_PCT10', 'H_PCT25', 'H_MEDIAN', 'H_PCT75',
  'H_PCT90', 'A_PCT10', 'A_PCT25', 'A_MEDIAN', 'A_PCT75', 'A_PCT90',
  'ANNUAL', 'HOURLY',
];

function row(area: string, areaTitle: string, occCode: string, h25: unknown, hMedian: unknown, h75: unknown): unknown[] {
  const r = new Array(HEADER.length).fill('');
  r[0] = area;
  r[1] = areaTitle;
  r[3] = 'TX';
  r[8] = occCode;
  r[21] = h25;
  r[22] = hMedian;
  r[23] = h75;
  return r;
}

describe('oews-bulk-parser: parseOewsBulkRows', () => {
  const targetOccCodes = new Set(['47-2111', '47-2081']);
  const targetAreaCodes = new Set(['12420', '4800001', '48']);

  it('extracts wage cells for target (area, occ) combinations', () => {
    const rows = [
      HEADER,
      row('12420', 'Austin-Round Rock-San Marcos, TX', '47-2111', 22.97, 29.03, 35.25),
      row('4800001', 'Northwestern Region of Texas nonmetropolitan area', '47-2111', 22.07, 28.98, 37.03),
      row('48', 'Texas', '47-2111', 22.44, 28.16, 34.2),
    ];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.get(oewsCellKey('12420', '47-2111'))).toEqual({ p25_hourly: 22.97, p50_hourly: 29.03, p75_hourly: 35.25 });
    expect(result.get(oewsCellKey('4800001', '47-2111'))).toEqual({ p25_hourly: 22.07, p50_hourly: 28.98, p75_hourly: 37.03 });
    expect(result.get(oewsCellKey('48', '47-2111'))).toEqual({ p25_hourly: 22.44, p50_hourly: 28.16, p75_hourly: 34.2 });
  });

  it('ignores rows for occ codes not in the target set', () => {
    const rows = [HEADER, row('12420', 'Austin', '47-9999', 20, 25, 30)];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.size).toBe(0);
  });

  it('ignores rows for areas not in the target set (e.g. national or another state)', () => {
    const rows = [HEADER, row('99', 'U.S.', '47-2111', 20, 25, 30)];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.size).toBe(0);
  });

  it('treats a suppressed cell (BLS marker "*") as absent, not a parsed zero', () => {
    const rows = [HEADER, row('12420', 'Austin', '47-2081', '*', '*', '*')];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.has(oewsCellKey('12420', '47-2081'))).toBe(false);
  });

  it('treats a blank/empty cell as absent', () => {
    const rows = [HEADER, row('12420', 'Austin', '47-2081', '', '', '')];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.has(oewsCellKey('12420', '47-2081'))).toBe(false);
  });

  it('drops a row whose wages fail the p25<=p50<=p75 structural check rather than trusting the source blindly', () => {
    const rows = [HEADER, row('12420', 'Austin', '47-2111', 40, 30, 20)];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.has(oewsCellKey('12420', '47-2111'))).toBe(false);
  });

  it('is resilient to a header with columns in the documented BLS order but tolerates blank rows', () => {
    const rows = [HEADER, [], row('12420', 'Austin', '47-2111', 22.97, 29.03, 35.25)];
    const result = parseOewsBulkRows(rows, targetOccCodes, targetAreaCodes);
    expect(result.size).toBe(1);
  });
});
