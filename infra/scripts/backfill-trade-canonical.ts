/**
 * Operator CLI: backfill canonical worker trades (sprint 24 L6).
 *
 * Every worker whose trade was typed as free text carries whatever they wrote
 * in `users.main_trade_other` — "soldador", "Soldadura" and "welder" are one
 * trade stored three ways. This resolves each stored string through the
 * bilingual `trade_aliases` cache (migration 060) and rewrites it to the
 * canonical pair, exactly as `lambda/lib/trade-canonical.ts` now does at every
 * write site.
 *
 * Works over DISTINCT trade strings, not rows: one alias lookup and one UPDATE
 * per distinct spelling, and no user id, name, or phone is ever read or
 * printed — only trade text and row counts.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`.
 *
 * Usage:
 *   cd infra
 *   DB_HOST=<host> DB_PORT=5432 DB_NAME=jale DB_USER=jale_admin DB_PASSWORD=<pw> \
 *   npx ts-node scripts/backfill-trade-canonical.ts
 *   npx ts-node scripts/backfill-trade-canonical.ts --lang en
 *   npx ts-node scripts/backfill-trade-canonical.ts --apply
 *
 * `--lang` (default `es`) picks which canonical name a resolved custom trade
 * is stored under. `users` carries no per-worker language column — it lives on
 * `whatsapp_conversations` and the onboarding runs — so this is an operator
 * decision, and 'es' matches both that column's DEFAULT and the language the
 * live write sites pin.
 *
 * Rows already canonical are left alone (no UPDATE is issued for them), so the
 * script is idempotent and safe to re-run.
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import {
  canonicalizeWorkerTrade,
  type CanonicalTrade,
  type TradeLang,
} from '../lambda/lib/trade-canonical';

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** Which lane a stored trade string took. */
export type BackfillOutcome =
  /** Resolved onto a standard `users.main_trade` enum key. */
  | 'resolved_standard'
  /** Resolved, but stays custom — its canonical name replaces the raw text. */
  | 'resolved_other'
  /** No `trade_aliases` row; only tidied. The alias generator has not learned
   * this trade yet, so re-run after it has. */
  | 'unresolved';

export interface BackfillPlanEntry {
  /** The stored `main_trade_other` string, verbatim. */
  before: string;
  /** How many `users` rows carry exactly this string. */
  rows: number;
  outcome: BackfillOutcome;
  mainTrade: string;
  mainTradeOther: string | null;
  /** What the trade will read as afterwards, for the printed diff. */
  after: string;
  /** False when the stored pair is already canonical — no UPDATE needed. */
  changed: boolean;
}

export interface BackfillSummary {
  resolved_standard: number;
  resolved_other: number;
  unresolved: number;
  /** Distinct strings that need an UPDATE, and the rows behind them. */
  changedStrings: number;
  changedRows: number;
  totalStrings: number;
  totalRows: number;
}

/**
 * Pure classification of ONE stored trade string against its canonicalisation.
 * All the script's decision-making lives here so it can be tested without a
 * database.
 */
export function classifyBackfillRow(
  before: string,
  rows: number,
  canonical: CanonicalTrade,
): BackfillPlanEntry {
  // A blank canonical name with main_trade='other' is the one pair
  // `chk_trade_other` rejects; treat it as nothing to do.
  const writable = canonical.main_trade !== 'other' || !!canonical.main_trade_other;

  const outcome: BackfillOutcome = !canonical.resolved
    ? 'unresolved'
    : canonical.main_trade === 'other'
      ? 'resolved_other'
      : 'resolved_standard';

  const changed =
    writable &&
    (canonical.main_trade !== 'other' || canonical.main_trade_other !== before);

  return {
    before,
    rows,
    outcome,
    mainTrade: canonical.main_trade,
    mainTradeOther: canonical.main_trade_other,
    after:
      canonical.main_trade === 'other'
        ? (canonical.main_trade_other ?? before)
        : `[main_trade=${canonical.main_trade}]`,
    changed,
  };
}

/** Pure roll-up of a plan into the counts the dry run prints. */
export function summarizeBackfillPlan(entries: BackfillPlanEntry[]): BackfillSummary {
  const summary: BackfillSummary = {
    resolved_standard: 0,
    resolved_other: 0,
    unresolved: 0,
    changedStrings: 0,
    changedRows: 0,
    totalStrings: entries.length,
    totalRows: 0,
  };

  for (const entry of entries) {
    summary[entry.outcome] += entry.rows;
    summary.totalRows += entry.rows;
    if (entry.changed) {
      summary.changedStrings += 1;
      summary.changedRows += entry.rows;
    }
  }

  return summary;
}

export type BackfillArgs = { apply: boolean; lang: TradeLang };
export type ParseBackfillArgsResult =
  | { ok: true; value: BackfillArgs }
  | { ok: false; error: string };

const USAGE =
  'usage: backfill-trade-canonical.ts [--apply] [--lang es|en]  (dry run by default)';

export function parseBackfillArgs(argv: string[]): ParseBackfillArgsResult {
  let apply = false;
  let lang: TradeLang = 'es';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--lang') {
      const value = argv[i + 1];
      if (value !== 'es' && value !== 'en') {
        return { ok: false, error: `--lang must be 'es' or 'en'\n${USAGE}` };
      }
      lang = value;
      i += 1;
    } else {
      return { ok: false, error: `unknown argument: ${arg}\n${USAGE}` };
    }
  }

  return { ok: true, value: { apply, lang } };
}

/**
 * Groups every custom trade by its stored text. Deliberately selects NO
 * identifying column: this script must never be able to print who has which
 * trade.
 */
const SELECT_DISTINCT_TRADES = `SELECT main_trade_other AS before, COUNT(*)::int AS rows
     FROM users
    WHERE main_trade = 'other'
      AND main_trade_other IS NOT NULL
      AND btrim(main_trade_other) <> ''
    GROUP BY main_trade_other
    ORDER BY main_trade_other`;

/** Rewrites every row carrying exactly `before` — one statement per string. */
const UPDATE_TRADE = `UPDATE users
      SET main_trade = $2,
          main_trade_other = $3
    WHERE main_trade = 'other'
      AND main_trade_other = $1`;

export async function buildBackfillPlan(
  client: Queryable,
  lang: TradeLang,
): Promise<BackfillPlanEntry[]> {
  const result = await client.query(SELECT_DISTINCT_TRADES);
  const entries: BackfillPlanEntry[] = [];

  for (const row of result.rows ?? []) {
    const before = String(row.before ?? '');
    const rows = Number(row.rows ?? 0);
    if (!before) continue;
    const canonical = await canonicalizeWorkerTrade(client as never, { raw: before, lang });
    entries.push(classifyBackfillRow(before, rows, canonical));
  }

  return entries;
}

const OUTCOME_LABEL: Record<BackfillOutcome, string> = {
  resolved_standard: 'resolved -> standard main_trade',
  resolved_other: 'resolved -> canonical custom trade',
  unresolved: 'unresolved (alias cache has not learned it yet)',
};

export function formatBackfillReport(
  entries: BackfillPlanEntry[],
  summary: BackfillSummary,
  args: BackfillArgs,
): string {
  const lines: string[] = [];
  lines.push(
    args.apply
      ? `backfill-trade-canonical: APPLYING (lang=${args.lang})`
      : `backfill-trade-canonical: DRY RUN — nothing will be written (lang=${args.lang}). Re-run with --apply.`,
  );
  lines.push('');
  lines.push(`rows by outcome (${summary.totalRows} worker rows, ${summary.totalStrings} distinct trade strings):`);
  for (const outcome of Object.keys(OUTCOME_LABEL) as BackfillOutcome[]) {
    lines.push(`  ${String(summary[outcome]).padStart(6)}  ${OUTCOME_LABEL[outcome]}`);
  }
  lines.push('');
  lines.push(`to rewrite: ${summary.changedRows} rows across ${summary.changedStrings} distinct strings`);

  const changed = entries.filter((e) => e.changed);
  if (changed.length > 0) {
    lines.push('');
    lines.push('before -> after (trade text only):');
    for (const entry of changed) {
      lines.push(`  ${JSON.stringify(entry.before)} -> ${JSON.stringify(entry.after)}  (${entry.rows} row${entry.rows === 1 ? '' : 's'}, ${entry.outcome})`);
    }
  }

  const unchanged = entries.filter((e) => !e.changed);
  if (unchanged.length > 0) {
    lines.push('');
    lines.push(`already canonical, left alone: ${unchanged.length} distinct string${unchanged.length === 1 ? '' : 's'}`);
    for (const entry of unchanged) {
      lines.push(`  ${JSON.stringify(entry.before)}  (${entry.rows} row${entry.rows === 1 ? '' : 's'}, ${entry.outcome})`);
    }
  }

  return lines.join('\n');
}

export async function runBackfill(
  client: Queryable,
  args: BackfillArgs,
): Promise<BackfillSummary> {
  const entries = await buildBackfillPlan(client, args.lang);
  const summary = summarizeBackfillPlan(entries);

  console.log(formatBackfillReport(entries, summary, args));

  if (!args.apply) return summary;

  // One transaction for the whole rewrite: a half-applied backfill would leave
  // the same trade canonical for some workers and raw for others.
  await client.query('BEGIN');
  try {
    for (const entry of entries) {
      if (!entry.changed) continue;
      await client.query(UPDATE_TRADE, [entry.before, entry.mainTrade, entry.mainTradeOther]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  console.log('');
  console.log(`applied: ${summary.changedRows} rows rewritten`);
  return summary;
}

async function main(): Promise<void> {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'jale',
    user: process.env.DB_USER ?? 'jale_admin',
    password: process.env.DB_PASSWORD,
    ssl:
      process.env.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ca: fs.readFileSync(
              path.join(__dirname, '../lambda/lib/rds-ca-bundle.pem'),
              'utf-8',
            ),
          }
        : false,
  });

  await client.connect();
  try {
    await runBackfill(client, parsed.value);
  } catch (err) {
    console.error(
      'backfill-trade-canonical failed:',
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void main();
}
