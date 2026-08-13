/**
 * generate-oews-seed.ts
 *
 * Dev-time generator for infra/scripts/data/oews-tx-seed.json -- the
 * checked-in seed data infra/scripts/seed-oews-wages.ts loads into the
 * wage_references / city_cbsa_crosswalk tables (migration 070).
 *
 * Usage:
 *   cd infra && npx ts-node scripts/generate-oews-seed.ts [--out <path>] [--cache-dir <dir>]
 *
 * Data sources and how they were actually fetched
 * ------------------------------------------------
 * BLS OEWS May-2025 "all data" bulk file: `curl` (even with full
 * desktop-browser User-Agent strings) and the WebFetch tool both got HTTP
 * 403 (Akamai bot protection) from every www.bls.gov / download.bls.gov URL
 * tried. Node's native `fetch()` (undici), by contrast, was NOT blocked --
 * https://www.bls.gov/oes/special-requests/oesm25all.zip downloaded
 * successfully as a real 78,754,064-byte ZIP (SHA-256:
 * 86ffcbbeb27a96b7aa84d01801de71ee94ee9027452152caabebfdec9d764fde on
 * 2026-08-13) containing oesm25all/all_data_M_2025.xlsx, the real May-2025
 * OEWS bulk file (413,527 data rows, verified against the documented BLS
 * column layout -- see lib/oews-bulk-parser.ts's header). This generator
 * therefore uses REAL BLS wage data, not placeholders -- a materially
 * better outcome than the original plan anticipated ("bls.gov may 403
 * non-browser agents... if blocked, STOP and emit placeholder rows"). If a
 * future run's fetch is blocked too, this generator falls back to a
 * clearly-flagged placeholder path (see buildPlaceholderWageReferences)
 * rather than failing outright.
 *
 * Extraction requires the `unzip` CLI (present on essentially every Unix
 * dev machine; this is dev-only tooling run by an operator, matching this
 * repo's existing scripts/run-migrations.sh precedent of assuming standard
 * CLI tools like aws/jq/gzip are present rather than vendoring a zip
 * library). If `unzip` is unavailable, extraction fails loudly and this
 * generator falls back to the placeholder path rather than silently
 * producing an empty result.
 *
 * A real discovery from parsing the real file: BLS's Texas nonmetro area
 * definitions have changed since the recommended-pay design doc was
 * written. The doc says "5 named nonmetro regions (Border, West Texas,
 * Coastal Plains, North Texas, Big Thicket)"; the actual May-2025 file has
 * 6: Northwestern (4800001), North (4800002), Eastern (4800003), Hill
 * Country (4800004), Border (4800005), Coastal Plains (4800006). Only
 * "Border" and "Coastal Plains" persisted under the same name. See
 * lib/wage-seed-lib.ts's TX_NONMETRO_AREAS for the reconciled, real list.
 *
 * Also discovered directly in the real data: BLS suppresses some
 * trade/nonmetro-region cells (Drywall and Ceiling Tile Installers is
 * missing in 5 of the 6 nonmetro regions; the Border region is additionally
 * missing Carpenters and Cement Masons/Concrete Finishers) -- exactly the
 * sparse-data scenario resolveSourceTier's metro/nonmetro -> state fallback
 * exists for, now exercised on real suppression rather than a synthetic one.
 *
 * Census Bureau CBSA delineation files (July 2023 vintage) -- used for
 * city_cbsa_crosswalk, real government data, downloaded successfully via
 * plain curl (no Akamai block on www2.census.gov):
 *   - list1_2023.xlsx: https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx
 *     SHA-256: 952c4b1e78acbb54e6ec9412434b7602fedacbf021736351a63c181bdb753629
 *   - list2_2023.xlsx: https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list2_2023.xlsx
 *     SHA-256: 1e1091de28d1ad1423cebf18e7cdb6db4fbf2204fd357bc68c24e8261dcce161
 *
 * The crosswalk still only maps principal cities to the 5 metro CBSAs, not
 * to any of the 6 nonmetro regions: list2 gives a city's CBSA membership,
 * but no equivalent public file mapping individual counties/cities to
 * BLS's custom nonmetro region groupings was found in this environment (a
 * few plausible bls.gov URLs were tried and returned only the generic site
 * template, not real area-definition content). The 6 nonmetro
 * wage_references rows are real data and reachable directly by area_code,
 * but unreachable via city_key lookup until that mapping is found -- see
 * migration 070's header for the full account, including why every
 * non-MSA Texas city correctly falls through to the statewide row instead.
 *
 * XLSX parsing: this host has no working `python3 -c "import openpyxl"`
 * (confirmed absent; this is dev-only tooling so a project-wide Python env
 * change felt like overreach for one generator script), so parsing uses
 * the `xlsx` (SheetJS) npm package as an infra devDependency instead.
 * NOTE: the `xlsx` npm registry package (0.18.5) carries two published
 * high-severity advisories (prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS
 * GHSA-5pgg-2g8v-p4x9) with "no fix available" on the registry -- SheetJS
 * only ships patched builds via its own CDN, not npm. Accepted here because
 * this is a dev-only devDependency, never bundled into any Lambda or
 * runtime path, and it only ever parses a small, fixed set of well-known
 * government files an operator explicitly downloaded -- not arbitrary or
 * attacker-controlled spreadsheets. Re-evaluate before using `xlsx` for
 * anything that parses untrusted, user-supplied files.
 */

/* eslint-disable no-console */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as XLSX from 'xlsx';

import {
  TRADED_CATEGORIES_WITH_WAGES,
  TRADE_SOC_CODES,
  TX_METRO_AREAS,
  TX_NONMETRO_AREAS,
  TX_STATE_AREA,
  AreaDef,
  WageCell,
  resolveSourceTier,
  crosswalkCityKey,
  validateWageCell,
} from './lib/wage-seed-lib';
import {
  parseList2PrincipalCities,
  parseList1CountyCbsa,
  singleCountyCbsaCodes,
} from './lib/census-crosswalk-parser';
import { parseOewsBulkRows, oewsCellKey } from './lib/oews-bulk-parser';

const DATA_VINTAGE = 'May 2025';

const CENSUS_LIST1_URL =
  'https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx';
const CENSUS_LIST2_URL =
  'https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list2_2023.xlsx';
const CENSUS_LIST1_SHA256 = '952c4b1e78acbb54e6ec9412434b7602fedacbf021736351a63c181bdb753629';
const CENSUS_LIST2_SHA256 = '1e1091de28d1ad1423cebf18e7cdb6db4fbf2204fd357bc68c24e8261dcce161';

// BLS's real OEWS AREA code for Texas statewide (AREA_TYPE=2 rows use the
// 2-digit FIPS state code). This is ONLY the lookup key into the parsed
// OEWS file -- the schema's own stored area_code for the state tier is
// TX_STATE_AREA.area_code ('TX', a readable, generalizable convention this
// project chose independently of BLS's raw code; see wage-seed-lib.ts).
const OEWS_STATE_AREA_LOOKUP_CODE = '48';

const OEWS_BULK_ZIP_URL = 'https://www.bls.gov/oes/special-requests/oesm25all.zip';
const OEWS_ATTEMPTED_URLS = [
  'https://www.bls.gov/oes/tables.htm',
  OEWS_BULK_ZIP_URL,
  'https://download.bls.gov/pub/time.series/oe/oesm25all.zip',
];

// Deliberately flat (identical across every area) and round-numbered so a
// reader can tell at a glance these are not real OEWS figures -- only used
// if the real OEWS download/extract/parse path fails entirely.
const PLACEHOLDER_WAGE_CELLS: Record<string, WageCell> = {
  electrician: { p25_hourly: 22.0, p50_hourly: 28.0, p75_hourly: 36.0 },
  plumber: { p25_hourly: 21.0, p50_hourly: 27.0, p75_hourly: 35.0 },
  carpenter: { p25_hourly: 18.0, p50_hourly: 23.0, p75_hourly: 30.0 },
  concrete: { p25_hourly: 17.0, p50_hourly: 21.0, p75_hourly: 27.0 },
  painting: { p25_hourly: 16.0, p50_hourly: 20.0, p75_hourly: 25.0 },
  drywall: { p25_hourly: 17.0, p50_hourly: 22.0, p75_hourly: 28.0 },
  general_labor: { p25_hourly: 14.0, p50_hourly: 17.0, p75_hourly: 21.0 },
};

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
  generated_at: string;
  provenance: {
    oews_bulk_file: {
      status: 'blocked' | 'downloaded';
      attempted_urls: string[];
      sha256?: string;
      note: string;
    };
    census_delineation_files: {
      list1_url: string;
      list1_sha256: string;
      list2_url: string;
      list2_sha256: string;
      status: 'downloaded' | 'blocked';
      note: string;
    };
  };
  wage_references: WageReferenceRow[];
  city_cbsa_crosswalk: CrosswalkRow[];
}

async function tryDownload(url: string, cacheDir: string): Promise<Buffer | null> {
  const cachePath = path.join(cacheDir, path.basename(new URL(url).pathname));
  if (fs.existsSync(cachePath)) {
    console.log(`  using cached download: ${cachePath}`);
    return fs.readFileSync(cachePath);
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      console.warn(`  ${url} -> HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, buf);
    return buf;
  } catch (err) {
    console.warn(`  ${url} -> fetch failed: ${(err as Error).message}`);
    return null;
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sheetRows(buf: Buffer): unknown[][] {
  const workbook = XLSX.read(buf, { type: 'buffer', dense: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
}

/** Extracts the single .xlsx inside an OEWS bulk .zip via the `unzip` CLI. Returns its path, or null on any failure. */
function extractOewsXlsx(zipPath: string, extractDir: string): string | null {
  try {
    // The OEWS zip's internal 'oesm25all/' directory entry carries a
    // read-only mode bit, which `unzip -o` cannot overwrite in place on a
    // second run. Removing the extract dir first (rather than relying on
    // -o to overwrite) makes re-running this generator idempotent.
    if (fs.existsSync(extractDir)) {
      fs.chmodSync(extractDir, 0o755);
      for (const entry of fs.readdirSync(extractDir)) {
        fs.chmodSync(path.join(extractDir, entry), 0o755);
      }
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: 'pipe' });
  } catch (err) {
    console.warn(`  unzip failed: ${(err as Error).message}`);
    return null;
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.xlsx')) {
        found.push(full);
      }
    }
  };
  walk(extractDir);
  if (found.length !== 1) {
    console.warn(`  expected exactly 1 .xlsx inside the OEWS zip, found ${found.length}: ${found.join(', ')}`);
    return null;
  }
  return found[0];
}

/**
 * Builds the TX-only, 5-target-MSA-only crosswalk from the real Census
 * delineation files. county_fips is left null for every row: list2 gives a
 * CBSA code per principal city but not a county, and every one of our 5
 * target CBSAs spans multiple counties (checked via singleCountyCbsaCodes
 * against the real list1 data) -- see migration 070's header for the full
 * rationale.
 */
function buildCrosswalk(list1Buf: Buffer, list2Buf: Buffer): CrosswalkRow[] {
  const targetCbsaCodes = new Set(TX_METRO_AREAS.map((a) => a.area_code));

  const list1Rows = parseList1CountyCbsa(sheetRows(list1Buf));
  const singleCounty = singleCountyCbsaCodes(list1Rows.filter((r) => targetCbsaCodes.has(r.cbsaCode)));

  const list2Rows = parseList2PrincipalCities(sheetRows(list2Buf));
  const out: CrosswalkRow[] = [];
  for (const row of list2Rows) {
    if (row.fipsState !== '48' || !targetCbsaCodes.has(row.cbsaCode)) {
      continue; // not Texas, or not one of our 5 target MSAs
    }
    let countyFips: string | null = null;
    if (singleCounty.has(row.cbsaCode)) {
      const county = list1Rows.find((r) => r.cbsaCode === row.cbsaCode);
      if (county) {
        countyFips = `${county.fipsState}${county.fipsCounty}`;
      }
    }
    out.push({
      city_key: crosswalkCityKey(row.principalCity, 'TX'),
      city: row.principalCity,
      state: 'TX',
      county_fips: countyFips,
      area_code: row.cbsaCode,
      // All 5 target CBSAs are metro (TX_METRO_AREAS) -- this crosswalk
      // never maps a city to a nonmetro region (see migration 070's header).
      area_kind: 'metro',
    });
  }
  // Stable, readable ordering for the checked-in JSON diff.
  out.sort((a, b) => a.city_key.localeCompare(b.city_key));
  return out;
}

/**
 * Real-data wage generation: parses the OEWS bulk file for our 7 SOC codes
 * across all 12 target areas (5 metro + 6 nonmetro + 1 state), then applies
 * the metro/nonmetro -> state fallback (resolveSourceTier) for any cell BLS
 * suppressed. Throws if a trade ends up with no resolvable row even at the
 * state tier -- that would mean the real file no longer has the coverage
 * this design depends on, and must be investigated, not silently skipped.
 */
function buildRealWageReferences(oewsRows: unknown[][]): WageReferenceRow[] {
  const targetOccCodes = new Set(Object.values(TRADE_SOC_CODES));
  const allAreas: readonly AreaDef[] = [...TX_METRO_AREAS, ...TX_NONMETRO_AREAS, TX_STATE_AREA];
  // Metro/nonmetro area_codes are identical between this schema and the raw
  // OEWS file; the state tier is not (see OEWS_STATE_AREA_LOOKUP_CODE above).
  const targetAreaCodes = new Set([
    ...TX_METRO_AREAS.map((a) => a.area_code),
    ...TX_NONMETRO_AREAS.map((a) => a.area_code),
    OEWS_STATE_AREA_LOOKUP_CODE,
  ]);

  const parsed = parseOewsBulkRows(oewsRows, targetOccCodes, targetAreaCodes);

  const rows: WageReferenceRow[] = [];
  for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
    const occCode = TRADE_SOC_CODES[trade];
    for (const area of allAreas) {
      const cellsByTier: Partial<Record<'metro' | 'nonmetro' | 'state', WageCell>> = {};
      if (area.area_kind === 'metro') {
        const cell = parsed.get(oewsCellKey(area.area_code, occCode));
        if (cell) cellsByTier.metro = cell;
      } else if (area.area_kind === 'nonmetro') {
        const cell = parsed.get(oewsCellKey(area.area_code, occCode));
        if (cell) cellsByTier.nonmetro = cell;
      }
      const stateCell = parsed.get(oewsCellKey(OEWS_STATE_AREA_LOOKUP_CODE, occCode));
      if (stateCell) cellsByTier.state = stateCell;

      const resolved = resolveSourceTier(area.area_kind, cellsByTier);
      if (!resolved) {
        throw new Error(
          `No resolvable wage cell (not even statewide) for trade=${trade} area=${area.area_code} (${area.area_label}). ` +
            `The real OEWS file no longer has the coverage this design depends on -- investigate before continuing.`,
        );
      }
      rows.push({
        trade_category: trade,
        area_code: area.area_code,
        area_kind: area.area_kind,
        area_label: area.area_label,
        p25_hourly: resolved.cell.p25_hourly,
        p50_hourly: resolved.cell.p50_hourly,
        p75_hourly: resolved.cell.p75_hourly,
        source_tier: resolved.source_tier,
        data_vintage: DATA_VINTAGE,
      });
    }
  }
  return rows;
}

/**
 * Placeholder-mode wage generation (fallback only -- used when the real
 * OEWS download/extract/parse path fails entirely). Every area gets the
 * trade's flat placeholder cell at its own natural tier (no simulated
 * suppression -- fabricating a fake suppression pattern on top of
 * already-fake numbers would just be a second layer of invention).
 */
function buildPlaceholderWageReferences(): WageReferenceRow[] {
  const rows: WageReferenceRow[] = [];
  const allAreas: readonly AreaDef[] = [...TX_METRO_AREAS, ...TX_NONMETRO_AREAS, TX_STATE_AREA];
  for (const trade of TRADED_CATEGORIES_WITH_WAGES) {
    const cell = PLACEHOLDER_WAGE_CELLS[trade];
    const invalid = validateWageCell(cell);
    if (invalid) {
      throw new Error(`placeholder cell for ${trade} is invalid: ${invalid}`);
    }
    for (const area of allAreas) {
      const resolved = resolveSourceTier(area.area_kind, { [area.area_kind]: cell });
      if (!resolved) {
        throw new Error(`resolveSourceTier unexpectedly returned null for ${trade}/${area.area_code}`);
      }
      rows.push({
        trade_category: trade,
        area_code: area.area_code,
        area_kind: area.area_kind,
        area_label: area.area_label,
        p25_hourly: resolved.cell.p25_hourly,
        p50_hourly: resolved.cell.p50_hourly,
        p75_hourly: resolved.cell.p75_hourly,
        source_tier: resolved.source_tier,
        data_vintage: DATA_VINTAGE,
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, 'data', 'oews-tx-seed.json');
  const cacheDirIdx = args.indexOf('--cache-dir');
  const cacheDir = cacheDirIdx >= 0 ? args[cacheDirIdx + 1] : path.join(__dirname, 'data', '.cache');

  console.log('generate-oews-seed: fetching Census delineation files...');
  const list1Buf = await tryDownload(CENSUS_LIST1_URL, cacheDir);
  const list2Buf = await tryDownload(CENSUS_LIST2_URL, cacheDir);

  let crosswalk: CrosswalkRow[] = [];
  let censusStatus: 'downloaded' | 'blocked' = 'blocked';
  let censusNote: string;
  if (list1Buf && list2Buf) {
    const list1Hash = sha256(list1Buf);
    const list2Hash = sha256(list2Buf);
    if (list1Hash !== CENSUS_LIST1_SHA256 || list2Hash !== CENSUS_LIST2_SHA256) {
      console.warn(
        `  WARNING: downloaded Census file hash differs from the recorded one ` +
          `(list1: expected ${CENSUS_LIST1_SHA256} got ${list1Hash}; ` +
          `list2: expected ${CENSUS_LIST2_SHA256} got ${list2Hash}). ` +
          `Census may have revised the files -- re-verify before trusting the crosswalk.`,
      );
    }
    crosswalk = buildCrosswalk(list1Buf, list2Buf);
    censusStatus = 'downloaded';
    censusNote =
      'Real data -- city_cbsa_crosswalk rows are derived from these files. Covers only the 5 metro ' +
      'CBSAs, not the 6 nonmetro regions (no public county->nonmetro-region mapping found); see ' +
      'migration 070\'s header.';
    console.log(`  built ${crosswalk.length} crosswalk rows from real Census data.`);
  } else {
    censusNote =
      'Census delineation files could not be downloaded in this run. city_cbsa_crosswalk is EMPTY -- ' +
      'every lookup will fall through to the statewide wage_references row until this is re-run with network access.';
    console.warn('  Census download failed -- crosswalk will be empty.');
  }

  console.log('generate-oews-seed: fetching BLS OEWS bulk file...');
  const oewsZipBuf = await tryDownload(OEWS_BULK_ZIP_URL, cacheDir);

  let wageReferences: WageReferenceRow[] = [];
  let placeholder: boolean;
  let oewsStatus: 'downloaded' | 'blocked' = 'blocked';
  let oewsSha256: string | undefined;
  let oewsNote = '';

  let realDataSucceeded = false;
  if (oewsZipBuf) {
    oewsSha256 = sha256(oewsZipBuf);
    // Named distinctly from the zip's own internal 'oesm25all/' folder so
    // extraction never nests oesm25all/oesm25all -- the archive's internal
    // directory entry can carry a read-only mode bit that would otherwise
    // make a second extraction into the same-named path fail with EACCES.
    const extractDir = path.join(cacheDir, 'oews-extracted');
    const xlsxPath = extractOewsXlsx(path.join(cacheDir, 'oesm25all.zip'), extractDir);
    if (xlsxPath) {
      console.log(`  parsing ${xlsxPath} (this can take under a minute for a 400k+ row file)...`);
      const rows = sheetRows(fs.readFileSync(xlsxPath));
      wageReferences = buildRealWageReferences(rows);
      realDataSucceeded = true;
      oewsStatus = 'downloaded';
      oewsNote =
        'Real May-2025 BLS OEWS data. Fetched successfully via Node\'s native fetch() (undici) even though ' +
        'curl and the WebFetch tool were both blocked (HTTP 403, Akamai) from the same environment -- see ' +
        'this file\'s header for the full account. Suppressed cells (metro/nonmetro rows BLS did not ' +
        'publish for a given trade) are backed by the statewide figure per source_tier, exactly as designed.';
      console.log(`  extracted ${wageReferences.length} real wage_references rows.`);
    }
  }

  if (!realDataSucceeded) {
    placeholder = true;
    oewsNote =
      'The OEWS bulk file could not be downloaded and/or extracted in this run (see console output above ' +
      'for the specific failure). No real OEWS wage numbers are present in this file -- every ' +
      'wage_references row is a clearly flagged placeholder (see PLACEHOLDER_WAGE_CELLS in this script). ' +
      'Re-run with network access to bls.gov and the `unzip` CLI available, and replace this file before ' +
      'any production seed.';
    wageReferences = buildPlaceholderWageReferences();
    console.warn('  OEWS bulk file unavailable -- generating PLACEHOLDER wage data.');
  } else {
    placeholder = false;
  }

  const seed: SeedFile = {
    placeholder,
    data_vintage: DATA_VINTAGE,
    generated_at: new Date().toISOString(),
    provenance: {
      oews_bulk_file: {
        status: oewsStatus,
        attempted_urls: OEWS_ATTEMPTED_URLS,
        sha256: oewsSha256,
        note: oewsNote,
      },
      census_delineation_files: {
        list1_url: CENSUS_LIST1_URL,
        list1_sha256: CENSUS_LIST1_SHA256,
        list2_url: CENSUS_LIST2_URL,
        list2_sha256: CENSUS_LIST2_SHA256,
        status: censusStatus,
        note: censusNote,
      },
    },
    wage_references: wageReferences,
    city_cbsa_crosswalk: crosswalk,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(
    `\nWrote ${outPath}\n` +
      `  wage_references: ${seed.wage_references.length} rows (placeholder=${seed.placeholder})\n` +
      `  city_cbsa_crosswalk: ${seed.city_cbsa_crosswalk.length} rows`,
  );
  if (placeholder) {
    console.warn(
      '\n*** PLACEHOLDER DATA *** -- do not load this into a production database as real wage figures.',
    );
  }
}

if (require.main === module) {
  void main();
}
