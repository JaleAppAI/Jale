/**
 * census-crosswalk-parser.ts
 *
 * Pure parsers for the Census Bureau's July 2023 CBSA delineation files
 * (list1_2023.xlsx, list2_2023.xlsx -- see generate-oews-seed.ts's header
 * for the exact URLs and SHA-256 hashes; both were downloaded successfully
 * on 2026-08-13 and their real layout verified directly against the files).
 *
 * These functions take already-parsed 2D sheet arrays (the shape
 * `XLSX.utils.sheet_to_json(worksheet, { header: 1 })` returns) rather than
 * touching the filesystem or the `xlsx` package themselves, so they are
 * importable from jest with a small hand-built fixture and no dependency on
 * the real files being present.
 *
 * Both files share the same layout: two title rows, one header row (at
 * sheet row 3 / array index 2), then data. Parsing here is column-POSITION
 * based (not header-name lookup) because the position was verified directly
 * against the real, currently-published files -- Census does not version
 * these files' internal column order independently of the filename
 * (list1_2023.xlsx / list2_2023.xlsx already encode the vintage), so a
 * future vintage would ship as a new file, not silently reordered columns
 * in this one.
 */

export interface CensusPrincipalCityRow {
  cbsaCode: string;
  cbsaTitle: string;
  areaType: string; // 'Metropolitan Statistical Area' | 'Micropolitan Statistical Area'
  principalCity: string;
  fipsState: string;
}

/**
 * list2_2023.xlsx ("PRINCIPAL CITIES OF METROPOLITAN AND MICROPOLITAN
 * STATISTICAL AREAS"). Columns: A=CBSA Code, B=CBSA Title,
 * C=Metropolitan/Micropolitan Statistical Area, D=Principal City Name,
 * E=FIPS State Code, F=FIPS Place Code (F is not extracted -- not needed to
 * build the crosswalk).
 */
export function parseList2PrincipalCities(rows: readonly unknown[][]): CensusPrincipalCityRow[] {
  const dataRows = rows.slice(3);
  const out: CensusPrincipalCityRow[] = [];
  for (const row of dataRows) {
    const cbsaCode = row?.[0];
    const cbsaTitle = row?.[1];
    const areaType = row?.[2];
    const principalCity = row?.[3];
    const fipsState = row?.[4];
    if (!cbsaCode || !principalCity) {
      continue; // blank/malformed row -- skip rather than guess
    }
    out.push({
      cbsaCode: String(cbsaCode),
      cbsaTitle: String(cbsaTitle ?? ''),
      areaType: String(areaType ?? ''),
      principalCity: String(principalCity),
      fipsState: String(fipsState ?? ''),
    });
  }
  return out;
}

export interface CensusCountyCbsaRow {
  cbsaCode: string;
  cbsaTitle: string;
  county: string;
  fipsState: string;
  fipsCounty: string;
}

/**
 * list1_2023.xlsx ("CORE BASED STATISTICAL AREAS (CBSAs), METROPOLITAN
 * DIVISIONS, AND COMBINED STATISTICAL AREAS (CSAs)"). Columns: A=CBSA Code,
 * B=Metropolitan Division Code, C=CSA Code, D=CBSA Title,
 * E=Metropolitan/Micropolitan Statistical Area, F=Metropolitan Division
 * Title, G=CSA Title, H=County/County Equivalent, I=State Name, J=FIPS
 * State Code, K=FIPS County Code, L=Central/Outlying County.
 *
 * Used here only to decide whether a CBSA is single- or multi-county (see
 * singleCountyCbsaCodes) -- county_fips is left NULL in the crosswalk for
 * every multi-county CBSA rather than guessing which county a principal
 * city sits in.
 */
export function parseList1CountyCbsa(rows: readonly unknown[][]): CensusCountyCbsaRow[] {
  const dataRows = rows.slice(3);
  const out: CensusCountyCbsaRow[] = [];
  for (const row of dataRows) {
    const cbsaCode = row?.[0];
    const cbsaTitle = row?.[3];
    const county = row?.[7];
    const fipsState = row?.[9];
    const fipsCounty = row?.[10];
    if (!cbsaCode || !county) {
      continue;
    }
    out.push({
      cbsaCode: String(cbsaCode),
      cbsaTitle: String(cbsaTitle ?? ''),
      county: String(county),
      fipsState: String(fipsState ?? ''),
      fipsCounty: String(fipsCounty ?? ''),
    });
  }
  return out;
}

/** CBSA codes that have exactly one member county in the given list1 rows. */
export function singleCountyCbsaCodes(list1Rows: readonly CensusCountyCbsaRow[]): Set<string> {
  const countyCountByCbsa = new Map<string, number>();
  for (const row of list1Rows) {
    countyCountByCbsa.set(row.cbsaCode, (countyCountByCbsa.get(row.cbsaCode) ?? 0) + 1);
  }
  const singles = new Set<string>();
  for (const [cbsaCode, count] of countyCountByCbsa) {
    if (count === 1) {
      singles.add(cbsaCode);
    }
  }
  return singles;
}
