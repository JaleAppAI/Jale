#!/usr/bin/env node
/**
 * `npm audit` as a CI gate with a DATED exception list.
 *
 * Runs `npm audit --json` in the current directory and fails when any advisory
 * at or above `--level` is present, UNLESS that advisory's GHSA id is listed in
 * the exceptions file with an `expires` date that has not passed. An expired
 * exception no longer excuses anything: the gate re-arms on its own, so an
 * accepted risk cannot quietly become permanent.
 *
 * WHY THIS EXISTS (2026-09-09): built when Next.js 14.2.35 -- the latest
 * 14.x at the time -- carried two CRITICAL advisories whose only fix was
 * 15.5.24, a major upgrade, and a plain `npm audit --audit-level=critical`
 * had no way to say those two were not reachable in Jale's deployment (nor
 * would lowering the level, which would hide every future critical too).
 * Both apps are now on Next.js 16.3.4 and .github/audit-exceptions.json is
 * currently empty (2026-09-10) -- the mechanism stays in place at critical
 * for whatever the next unfixable advisory turns out to be.
 *
 * Usage (from the app directory whose lockfile is being audited):
 *   node ../scripts/npm-audit-gate.mjs --level critical [--omit-dev] [--exceptions <file>]
 *
 * Exit codes: 0 = clean or fully excepted; 1 = blocking advisories, expired
 * exceptions, a malformed exceptions file, or `npm audit` itself failing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const GHSA_ID = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXCEPTIONS_FILE = path.resolve(here, '..', '.github', 'audit-exceptions.json');

/**
 * Parses and validates the exceptions file. Every entry needs a GHSA id, the
 * package it excuses, a reason a reviewer can check, and an ISO expiry date;
 * anything else is a loud failure -- a half-written exception must never pass
 * as "no exceptions".
 */
export function parseExceptions(text, fileLabel = 'exceptions file') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${fileLabel}: not valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.exceptions)) {
    throw new Error(`${fileLabel}: expected an object with an "exceptions" array`);
  }
  const seen = new Set();
  return parsed.exceptions.map((entry, index) => {
    const where = `${fileLabel}: exceptions[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where}: not an object`);
    const { id, package: pkg, reason, expires } = entry;
    if (typeof id !== 'string' || !GHSA_ID.test(id)) throw new Error(`${where}: "id" must be a GHSA id`);
    if (typeof pkg !== 'string' || !pkg.trim()) throw new Error(`${where}: "package" is required`);
    if (typeof reason !== 'string' || reason.trim().length < 20) {
      throw new Error(`${where}: "reason" must explain the accepted risk (20+ characters)`);
    }
    if (typeof expires !== 'string' || !ISO_DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      throw new Error(`${where}: "expires" must be a YYYY-MM-DD date`);
    }
    const key = id.toUpperCase();
    if (seen.has(key)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(key);
    return { id: key, package: pkg.trim(), reason: reason.trim(), expires };
  });
}

export function loadExceptions(file = DEFAULT_EXCEPTIONS_FILE) {
  return parseExceptions(readFileSync(file, 'utf8'), path.relative(process.cwd(), file) || file);
}

/** Distinct advisories in an `npm audit --json` report, keyed by GHSA id. */
export function collectAdvisories(report) {
  const byId = new Map();
  for (const [dependency, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (!via || typeof via !== 'object') continue; // a string `via` is a transitive path, not an advisory
      const match = typeof via.url === 'string' ? via.url.match(GHSA_ID) : null;
      const id = (match ? match[0] : `${via.source ?? 'unknown'}`).toUpperCase();
      const existing = byId.get(id);
      if (existing) {
        existing.dependencies.add(dependency);
        continue;
      }
      byId.set(id, {
        id,
        package: via.name ?? dependency,
        severity: via.severity ?? 'unknown',
        title: via.title ?? '',
        url: via.url ?? '',
        dependencies: new Set([dependency]),
      });
    }
  }
  return [...byId.values()].map((a) => ({ ...a, dependencies: [...a.dependencies].sort() }));
}

/**
 * The decision. `today` is an ISO date (UTC); an exception whose `expires` is
 * BEFORE today is expired. An exception that names an advisory no longer in
 * the report is `unused` -- reported so it can be deleted, never a failure.
 */
export function evaluateAudit(report, exceptions, { level = 'high', today }) {
  const threshold = SEVERITY_RANK[level];
  if (threshold === undefined) throw new Error(`unknown audit level "${level}"`);
  if (typeof today !== 'string' || !ISO_DATE.test(today)) throw new Error('today must be a YYYY-MM-DD date');
  if (report && report.error) {
    throw new Error(`npm audit reported an error: ${report.error.summary ?? report.error.code ?? JSON.stringify(report.error)}`);
  }

  const byId = new Map(exceptions.map((e) => [e.id, e]));
  const blocking = [];
  const excepted = [];
  const expired = [];
  const usedIds = new Set();

  for (const advisory of collectAdvisories(report)) {
    if ((SEVERITY_RANK[advisory.severity] ?? SEVERITY_RANK.critical) < threshold) continue;
    const exception = byId.get(advisory.id);
    if (!exception) {
      blocking.push(advisory);
      continue;
    }
    usedIds.add(exception.id);
    if (exception.expires < today) expired.push({ advisory, exception });
    else excepted.push({ advisory, exception });
  }

  const unused = exceptions.filter((e) => !usedIds.has(e.id));
  return { ok: blocking.length === 0 && expired.length === 0, level, blocking, excepted, expired, unused };
}

function runNpmAudit({ omitDev }) {
  const args = ['audit', '--json'];
  if (omitDev) args.push('--omit=dev');
  // `npm audit` exits 1 whenever it finds anything; the JSON body is what
  // decides here, so the exit code is deliberately ignored and only a missing
  // or unparsable body is fatal.
  const result = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`could not run npm audit: ${result.error.message}`);
  const body = (result.stdout ?? '').trim();
  if (!body) throw new Error(`npm audit produced no JSON (exit ${result.status}): ${(result.stderr ?? '').trim().slice(0, 500)}`);
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`npm audit output is not JSON (${err.message}): ${body.slice(0, 500)}`);
  }
}

function parseArgs(argv) {
  const opts = { level: 'high', omitDev: false, exceptionsFile: DEFAULT_EXCEPTIONS_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--level') opts.level = argv[++i];
    else if (arg === '--omit-dev') opts.omitDev = true;
    else if (arg === '--exceptions') opts.exceptionsFile = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

function describe(advisory) {
  return `${advisory.id} ${advisory.severity.padEnd(8)} ${advisory.package}: ${advisory.title} (via ${advisory.dependencies.join(', ')})`;
}

export function main(argv = process.argv.slice(2), io = console) {
  const opts = parseArgs(argv);
  const exceptions = loadExceptions(opts.exceptionsFile);
  const report = runNpmAudit(opts);
  const today = new Date().toISOString().slice(0, 10);
  const verdict = evaluateAudit(report, exceptions, { level: opts.level, today });

  io.log(`npm audit gate: level=${opts.level} omit-dev=${opts.omitDev} today=${today} exceptions=${path.relative(process.cwd(), opts.exceptionsFile)}`);
  for (const { advisory, exception } of verdict.excepted) {
    io.log(`  excepted until ${exception.expires}: ${describe(advisory)}`);
    io.log(`    reason: ${exception.reason}`);
  }
  for (const e of verdict.unused) io.log(`  unused exception (delete it): ${e.id} ${e.package}`);
  for (const { advisory, exception } of verdict.expired) {
    io.error(`::error::exception EXPIRED on ${exception.expires}: ${describe(advisory)}`);
  }
  for (const advisory of verdict.blocking) io.error(`::error::blocking advisory: ${describe(advisory)}`);

  if (!verdict.ok) {
    io.error(`npm audit gate FAILED: ${verdict.blocking.length} blocking, ${verdict.expired.length} expired exception(s) at level ${opts.level}`);
    return 1;
  }
  io.log(`npm audit gate passed: ${verdict.excepted.length} excepted advisory(ies), nothing else at or above ${opts.level}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
