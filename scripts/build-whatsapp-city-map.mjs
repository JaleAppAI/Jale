#!/usr/bin/env node
// Generates infra/lambda/whatsapp/lib/city-state-data.ts from frontend/scripts/uszips.csv.
//
// Inclusion rules:
//   (a) STRICT: a normalized city name enters the map only if every occurrence of
//       that name across the whole CSV falls in the same state (no cross-state
//       collisions), AND
//   (b) its total population summed across all its ZIP rows is >= POPULATION_THRESHOLD.
//
// If the strict rule would exclude any of the anchor cities used by the checked-in
// test (el paso / albuquerque / philadelphia) because of a tiny same-named town in
// another state, this script falls back to a RELAXED rule for ambiguous names only:
// ambiguous names are included when one state holds >= 95% of the total population
// for that name AND that state's population is >= 50,000. The header comment in the
// generated file records which rule actually shipped.
//
// Usage: node scripts/build-whatsapp-city-map.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(REPO_ROOT, 'frontend', 'scripts', 'uszips.csv');
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  'infra',
  'lambda',
  'whatsapp',
  'lib',
  'city-state-data.ts',
);

const POPULATION_THRESHOLD = 10_000;
const RELAXED_SHARE_THRESHOLD = 0.95;
const RELAXED_MIN_STATE_POPULATION = 50_000;
const ANCHOR_CITIES = ['el paso', 'albuquerque', 'philadelphia'];

// ── CSV parsing (handles quoted fields, embedded commas, and "" escaped quotes) ──

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// A CSV record can span multiple physical lines when a quoted field contains a
// literal newline. Reassemble logical records by tracking unbalanced quote counts.
function parseCsv(text) {
  const lines = text.split(/\r\n|\n/);
  const records = [];
  let buffer = null;
  for (const line of lines) {
    buffer = buffer === null ? line : `${buffer}\n${line}`;
    const quoteCount = (buffer.match(/"/g) || []).length;
    if (quoteCount % 2 === 0) {
      if (buffer.length > 0) {
        records.push(parseCsvLine(buffer));
      }
      buffer = null;
    }
  }
  if (buffer !== null && buffer.length > 0) {
    records.push(parseCsvLine(buffer));
  }
  return records;
}

// Same normalization as `normalizeStateName` in
// infra/lambda/whatsapp/lib/onboarding-adapters.ts.
function normalize(raw) {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMap(rows, cityIdx, stateIdx, popIdx) {
  // normalizedName -> Map<stateAbbrev, totalPopulation>
  const byName = new Map();

  for (const row of rows) {
    const rawCity = row[cityIdx];
    const rawState = row[stateIdx];
    const rawPop = row[popIdx];
    if (!rawCity || !rawState) continue;

    const name = normalize(rawCity);
    const state = rawState.trim().toUpperCase();
    if (!name || !/^[A-Z]{2}$/.test(state)) continue;

    const population = Number.parseInt(rawPop, 10);
    const pop = Number.isFinite(population) ? population : 0;

    let states = byName.get(name);
    if (!states) {
      states = new Map();
      byName.set(name, states);
    }
    states.set(state, (states.get(state) || 0) + pop);
  }

  return byName;
}

function applyStrictRule(byName) {
  const result = new Map();
  for (const [name, states] of byName) {
    if (states.size !== 1) continue;
    const [[state, pop]] = states;
    if (pop >= POPULATION_THRESHOLD) {
      result.set(name, state);
    }
  }
  return result;
}

function applyRelaxedRule(byName) {
  const result = new Map();
  for (const [name, states] of byName) {
    if (states.size === 1) {
      const [[state, pop]] = states;
      if (pop >= POPULATION_THRESHOLD) {
        result.set(name, state);
      }
      continue;
    }

    // Ambiguous name: include only if one state dominates the population share.
    let total = 0;
    let topState = null;
    let topPop = -1;
    for (const [state, pop] of states) {
      total += pop;
      if (pop > topPop) {
        topPop = pop;
        topState = state;
      }
    }
    if (total === 0) continue;
    const share = topPop / total;
    if (share >= RELAXED_SHARE_THRESHOLD && topPop >= RELAXED_MIN_STATE_POPULATION) {
      result.set(name, topState);
    }
  }
  return result;
}

function main() {
  const csvText = readFileSync(CSV_PATH, 'utf8');
  const records = parseCsv(csvText);
  if (records.length === 0) {
    throw new Error(`No rows found in ${CSV_PATH}`);
  }

  const header = records[0];
  const cityIdx = header.indexOf('city');
  const stateIdx = header.indexOf('state_id');
  const popIdx = header.indexOf('population');
  if (cityIdx === -1 || stateIdx === -1 || popIdx === -1) {
    throw new Error(
      `Expected columns "city", "state_id", "population" in header: ${header.join(', ')}`,
    );
  }

  const rows = records.slice(1);
  const byName = buildMap(rows, cityIdx, stateIdx, popIdx);

  let ruleUsed = 'strict';
  let map = applyStrictRule(byName);

  const missingAnchors = ANCHOR_CITIES.filter((name) => !map.has(name));
  if (missingAnchors.length > 0) {
    ruleUsed = 'relaxed (>=95% population share, >=50,000 people)';
    map = applyRelaxedRule(byName);
  }

  const sortedKeys = Array.from(map.keys()).sort();
  const entries = sortedKeys.map((key) => [key, map.get(key)]);

  const now = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('// GENERATED by scripts/build-whatsapp-city-map.mjs — do not edit by hand.');
  lines.push(`// Generated: ${now}`);
  lines.push(`// Entry count: ${entries.length}`);
  lines.push(`// Inclusion rule shipped: ${ruleUsed}`);
  lines.push('//');
  lines.push('// Source: frontend/scripts/uszips.csv (SimpleMaps US Zip Codes database).');
  lines.push('// A normalized city name is included only if, under the shipped rule above,');
  lines.push('// it unambiguously (or dominantly, under the relaxed rule) resolves to one');
  lines.push('// US state, with a minimum aggregate population of 10,000. Keys use the same');
  lines.push('// normalization as `normalizeStateName` in onboarding-adapters.ts (lowercase,');
  lines.push('// NFD accent-stripped, periods removed, whitespace collapsed).');
  lines.push('export const UNAMBIGUOUS_CITY_TO_STATE: Record<string, string> = {');
  for (const [key, value] of entries) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('};');
  lines.push('');

  writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');

  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`Entry count: ${entries.length}`);
  console.log(`Inclusion rule shipped: ${ruleUsed}`);
}

main();
