// Trims a SimpleMaps US ZIP CSV (uszips.csv, CC BY 4.0 — attribution required;
// source: https://simplemaps.com/data/us-zips) into the bundled asset.
// Usage: place uszips.csv in this folder, then `node scripts/build-locations.mjs`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, 'uszips.csv');
const OUT = resolve(here, '../src/data/us-locations.json');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const text = readFileSync(SRC, 'utf8').trim();
const [header, ...lines] = text.split(/\r?\n/);
const cols = parseCsvLine(header);
const zi = cols.indexOf('zip');
const li = cols.indexOf('lat');
const gi = cols.indexOf('lng');
const ci = cols.indexOf('city');
const si = cols.indexOf('state_id');
const pi = cols.indexOf('population');
if ([zi, li, gi, ci, si].some((i) => i < 0)) {
  throw new Error(`Unexpected CSV columns: ${cols.join(',')}`);
}

const records = [];
for (const line of lines) {
  if (!line) continue;
  const f = parseCsvLine(line);
  const zip = f[zi];
  const lat = Number(f[li]);
  const lon = Number(f[gi]);
  if (!zip || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const rec = { zip, city: f[ci], state: f[si], lat, lon };
  const pop = pi >= 0 ? Number(f[pi]) : NaN;
  if (Number.isFinite(pop) && pop > 0) rec.pop = pop;
  records.push(rec);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(records));
console.log(`Wrote ${records.length} records → ${OUT}`);
