import {
  parseList2PrincipalCities,
  parseList1CountyCbsa,
  singleCountyCbsaCodes,
} from '../../../scripts/lib/census-crosswalk-parser';

// Fixture rows mirror the REAL structure of list2_2023.xlsx verified against
// the downloaded file on 2026-08-13 (2 title rows, 1 header row, then data):
// A=CBSA Code, B=CBSA Title, C=Metro/Micro type, D=Principal City Name,
// E=FIPS State Code, F=FIPS Place Code.
const LIST2_FIXTURE: unknown[][] = [
  ['Table with row headers in column A and column headers in row 3'],
  ['List 2. PRINCIPAL CITIES OF METROPOLITAN AND MICROPOLITAN STATISTICAL AREAS, JULY 2023'],
  ['CBSA Code', 'CBSA Title', 'Metropolitan/Micropolitan Statistical Area', 'Principal City Name', 'FIPS State Code', 'FIPS Place Code'],
  ['10100', 'Aberdeen, SD', 'Micropolitan Statistical Area', 'Aberdeen', '46', '00100'],
  ['12420', 'Austin-Round Rock-San Marcos, TX', 'Metropolitan Statistical Area', 'Austin', '48', '05000'],
  ['12420', 'Austin-Round Rock-San Marcos, TX', 'Metropolitan Statistical Area', 'Round Rock', '48', '63344'],
  ['21340', 'El Paso, TX', 'Metropolitan Statistical Area', 'El Paso', '48', '24000'],
  [], // a blank row must not crash the parser
  ['19100', 'Dallas-Fort Worth-Arlington, TX', 'Metropolitan Statistical Area', 'Dallas', '48', '19000'],
];

// Fixture mirrors list1_2023.xlsx's real structure (verified 2026-08-13):
// A=CBSA Code, B=Met Div Code, C=CSA Code, D=CBSA Title, E=Metro/Micro type,
// F=Met Div Title, G=CSA Title, H=County, I=State Name, J=FIPS State Code,
// K=FIPS County Code, L=Central/Outlying.
const LIST1_FIXTURE: unknown[][] = [
  ['Table with row headers in column A and column headers in row 3'],
  ['List 1. CORE BASED STATISTICAL AREAS (CBSAs)...'],
  ['CBSA Code', 'Metropolitan Division Code', 'CSA Code', 'CBSA Title', 'Metropolitan/Micropolitan Statistical Area', 'Metropolitan Division Title', 'CSA Title', 'County/County Equivalent', 'State Name', 'FIPS State Code', 'FIPS County Code', 'Central/Outlying County'],
  ['21340', null, null, 'El Paso, TX', 'Metropolitan Statistical Area', null, null, 'El Paso County', 'Texas', '48', '141', 'Central'],
  ['21340', null, null, 'El Paso, TX', 'Metropolitan Statistical Area', null, null, 'Hudspeth County', 'Texas', '48', '229', 'Outlying'],
  ['12420', null, '101', 'Austin-Round Rock-San Marcos, TX', 'Metropolitan Statistical Area', null, 'Austin-Round Rock, TX', 'Travis County', 'Texas', '48', '453', 'Central'],
  ['12420', null, '101', 'Austin-Round Rock-San Marcos, TX', 'Metropolitan Statistical Area', null, 'Austin-Round Rock, TX', 'Hays County', 'Texas', '48', '209', 'Central'],
];

describe('census-crosswalk-parser: parseList2PrincipalCities', () => {
  it('extracts principal-city rows, skipping title/header rows and blank rows', () => {
    const rows = parseList2PrincipalCities(LIST2_FIXTURE);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.principalCity === 'Austin')).toEqual({
      cbsaCode: '12420',
      cbsaTitle: 'Austin-Round Rock-San Marcos, TX',
      areaType: 'Metropolitan Statistical Area',
      principalCity: 'Austin',
      fipsState: '48',
    });
  });

  it('includes non-TX rows too (caller filters by fipsState)', () => {
    const rows = parseList2PrincipalCities(LIST2_FIXTURE);
    expect(rows.some((r) => r.fipsState === '46')).toBe(true);
  });
});

describe('census-crosswalk-parser: parseList1CountyCbsa', () => {
  it('extracts one row per CBSA/county pair', () => {
    const rows = parseList1CountyCbsa(LIST1_FIXTURE);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.cbsaCode === '21340')).toHaveLength(2);
    expect(rows.filter((r) => r.cbsaCode === '12420')).toHaveLength(2);
  });
});

describe('census-crosswalk-parser: singleCountyCbsaCodes', () => {
  it('returns only CBSA codes with exactly one member county (none of our fixture CBSAs qualify)', () => {
    const list1 = parseList1CountyCbsa(LIST1_FIXTURE);
    const singles = singleCountyCbsaCodes(list1);
    // Both fixture CBSAs (21340, 12420) have 2 counties each -> neither qualifies.
    expect(singles.has('21340')).toBe(false);
    expect(singles.has('12420')).toBe(false);
  });

  it('returns true single-county CBSAs when given one', () => {
    const singleCountyFixture: unknown[][] = [
      ...LIST1_FIXTURE.slice(0, 3),
      ['99999', null, null, 'Solo County Metro, TX', 'Metropolitan Statistical Area', null, null, 'Solo County', 'Texas', '48', '999', 'Central'],
    ];
    const singles = singleCountyCbsaCodes(parseList1CountyCbsa(singleCountyFixture));
    expect(singles.has('99999')).toBe(true);
  });
});
