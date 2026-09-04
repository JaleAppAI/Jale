/**
 * Canonical worker trades — sprint 24 L6.
 *
 * A worker's trade reaches `users` from four different doors (WhatsApp v2
 * onboarding, the web onboarding door, the web profile editor, voice
 * extraction) and until now each door stored whatever the worker typed.
 * "soldador", "Soldadura" and "welder" are one trade, but they were three
 * different strings — so the employer surfaces showed raw text and the
 * per-trade trust-question cache (`trade_questions.profession_key`) was
 * fragmented across spellings and languages.
 *
 * This module is the ONE place that turns raw trade text into the pair
 * `users` actually stores, using the bilingual `trade_aliases` cache
 * (migration 060, filled for unknown trades by `lambda/ai/alias-generator.ts`).
 *
 * Decision D4 (Luis): canonicalise to the WORKER'S language, set the standard
 * `main_trade` enum key when the alias row's `trade_category` maps back to one,
 * and otherwise keep the trade custom (`main_trade = 'other'`) with the
 * canonical name in `main_trade_other`. No enum change — welder stays custom.
 *
 * Two invariants this module exists to hold:
 *
 *   1. `users.main_trade` CHECK (004_whatsapp.sql:55-56) — the returned
 *      `main_trade` is ALWAYS a `TRADE_KEYS` member. In particular a
 *      `trade_category` of 'drywall' or 'general_labor' is a valid
 *      *jobs* category but NOT a valid `main_trade`, so those stay custom.
 *   2. `chk_trade_other` (004_whatsapp.sql:66-70) — `main_trade = 'other'`
 *      never comes back with a null `main_trade_other` unless the raw input
 *      was blank, in which case there is nothing to write at all and the
 *      caller must skip the write (see `canonicalizeWorkerTrade`).
 *
 * Fail-open by design: `trade_aliases` being unreachable degrades to exactly
 * the pre-L6 behaviour (store the worker's text, ask the generator to learn
 * the trade) rather than failing a profile save.
 */

import { normalizeProfession } from './profession';
import { TRADE_KEYS } from './worker-vocab';

/** The `trade_aliases` columns this module reads. */
export interface TradeAliasRow {
  trade_key: string;
  canonical_en: string;
  canonical_es: string;
  trade_category: string | null;
}

export type TradeLang = 'en' | 'es';

export interface CanonicalTrade {
  /** Always a `TRADE_KEYS` member. */
  main_trade: string;
  /** Non-null whenever `main_trade === 'other'` and the raw input was not blank. */
  main_trade_other: string | null;
  /** False when `trade_aliases` had no row (or was unreachable) — the caller
   * should then ask `requestTradeAliasGeneration` to learn this trade so the
   * NEXT write canonicalises. */
  resolved: boolean;
  /** The `trade_aliases.trade_key` that matched, when one did. */
  trade_key?: string;
}

/** Minimal `pg` surface — a PoolClient, a Client, or a transaction handle. */
export interface TradeAliasQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The standard `users.main_trade` keys: `TRADE_KEYS` without the 'other'
 * escape hatch. These are also exactly the five `trade_questions.profession_key`
 * rows migration 012 seeds (and 086 asserts still exist).
 */
const STANDARD_TRADE_KEYS: readonly string[] = Object.freeze(
  (TRADE_KEYS as readonly string[]).filter((key) => key !== 'other'),
);

/** True iff `value` is a standard (non-'other') `users.main_trade` key. */
export function isStandardTradeKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && STANDARD_TRADE_KEYS.includes(value);
}

/**
 * Reverse of job-matching.ts's `TRADE_TO_PROFESSION`, restricted to the
 * `users.main_trade` enum: a `trade_aliases.trade_category` maps back to a
 * standard trade key exactly when the category string IS that key.
 *
 * That map is module-private and job-matching.ts is owned by another lane, so
 * this derives the reverse from the two exported vocabularies instead of
 * copying it. `test/unit/lambda/lib/trade-canonical.test.ts` reads
 * `TRADE_TO_PROFESSION` out of job-matching.ts as text and fails if a
 * non-identity entry ever appears for a real `main_trade` key.
 *
 * Deliberately strict: 'drywall' and 'general_labor' are valid
 * `jobs.trade_category` values with no `main_trade` counterpart, and returning
 * them would produce an UPDATE the `main_trade` CHECK rejects.
 */
export function standardTradeKeyForCategory(
  category: string | null | undefined,
): string | null {
  return isStandardTradeKey(category) ? (category as string) : null;
}

/**
 * Trims, collapses internal whitespace, and upper-cases the FIRST letter only.
 * The rest is left exactly as typed so an acronym survives ("hvac TECH" ->
 * "Hvac TECH", never "Hvac tech").
 */
export function tidyTradeText(raw: string | null | undefined): string {
  const collapsed = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return '';
  return collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
}

const ALIAS_SQL = `SELECT trade_key, canonical_en, canonical_es, trade_category
     FROM trade_aliases
    WHERE trade_key = $1 OR $1 = ANY(aliases)
    LIMIT 1`;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * One lookup for one already-normalized key. Returns null unless the row
 * really is a `trade_aliases` row: several suites drive this code through a
 * shared in-memory fake client that answers EVERY query with a `users`-shaped
 * row, and a resolved-looking row with no `trade_key` would be worse than a
 * miss.
 */
async function selectAliasRow(
  client: TradeAliasQueryable,
  key: string,
): Promise<TradeAliasRow | null> {
  const result = await client.query(ALIAS_SQL, [key]);
  const row = result?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const tradeKey = nonEmptyString(row.trade_key);
  if (!tradeKey) return null;

  return {
    trade_key: tradeKey,
    canonical_en: nonEmptyString(row.canonical_en) ?? tradeKey,
    canonical_es: nonEmptyString(row.canonical_es) ?? tradeKey,
    trade_category: nonEmptyString(row.trade_category),
  };
}

/**
 * Resolves raw trade text against `trade_aliases`, matching `trade_key` or any
 * pre-normalized member of `aliases`. Retries once with a trailing plural 's'
 * stripped ("welders" -> "welder"). Blank input returns null without touching
 * the DB. A DB error propagates — callers that must not fail go through
 * `canonicalizeWorkerTrade`/`professionKeyForTrade`, which fail open.
 */
export async function resolveTradeAlias(
  client: TradeAliasQueryable,
  raw: string | null | undefined,
): Promise<TradeAliasRow | null> {
  const key = normalizeProfession(raw ?? '');
  if (!key) return null;

  const direct = await selectAliasRow(client, key);
  if (direct) return direct;

  // Only worth a second round trip for a real plural: 'as' -> 'a' is noise.
  const singular = key.endsWith('s') && key.length > 3 ? key.slice(0, -1) : null;
  if (!singular) return null;

  return selectAliasRow(client, singular);
}

/**
 * Turns raw trade text into the `main_trade`/`main_trade_other` pair to store,
 * canonicalised into `lang`.
 *
 * Fails OPEN: if `trade_aliases` is unreachable the result is the pre-L6
 * behaviour — the tidied raw text, `resolved: false` — so a profile save is
 * never lost to a cache outage. Callers should call
 * `requestTradeAliasGeneration` whenever `resolved` is false.
 *
 * A blank `raw` comes back as `{ main_trade: 'other', main_trade_other: null }`:
 * there is nothing to canonicalise and nothing to store, and the caller MUST
 * skip the write rather than trip `chk_trade_other`.
 */
export async function canonicalizeWorkerTrade(
  client: TradeAliasQueryable,
  input: { raw: string | null | undefined; lang?: TradeLang },
): Promise<CanonicalTrade> {
  const tidied = tidyTradeText(input.raw);
  const fallback: CanonicalTrade = {
    main_trade: 'other',
    main_trade_other: tidied || null,
    resolved: false,
  };
  if (!tidied) return fallback;

  let row: TradeAliasRow | null = null;
  try {
    row = await resolveTradeAlias(client, input.raw);
  } catch (err) {
    console.warn('[trade-canonical] alias lookup failed, storing raw trade', {
      event: 'trade_alias_lookup_failed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    });
    return fallback;
  }
  if (!row) return fallback;

  const standardKey = standardTradeKeyForCategory(row.trade_category);
  if (standardKey) {
    // A standard trade is fully described by the enum key; the free-text
    // column is cleared so no stale spelling survives beside it.
    return {
      main_trade: standardKey,
      main_trade_other: null,
      resolved: true,
      trade_key: row.trade_key,
    };
  }

  const canonical = input.lang === 'en' ? row.canonical_en : row.canonical_es;
  return {
    main_trade: 'other',
    main_trade_other: canonical || tidied,
    resolved: true,
    trade_key: row.trade_key,
  };
}

/**
 * The `trade_questions.profession_key` to generate/lookup trust questions
 * under, so every spelling and language of one trade shares one question set.
 *
 * Three lanes, in order:
 *
 *   1. Raw text that already IS a standard `main_trade` key returns unchanged,
 *      with NO DB round trip. This lane is load-bearing: migration 012 seeds
 *      `profession_key = 'painting'` (and 086 asserts those five seeded rows),
 *      while 060's painter alias row is keyed 'painter' — an unguarded alias
 *      lookup would silently orphan every standard painting worker from the
 *      seeded question set.
 *   2. A resolved alias row whose `trade_category` maps back to a standard key
 *      returns that key, so a worker who typed "pintor" shares the seeded
 *      'painting' questions.
 *   3. Otherwise the alias row's `trade_key` ('welder' for soldador /
 *      Soldadura / welding), or `normalizeProfession(raw)` on a miss.
 *
 * Never throws: any lookup failure falls back to `normalizeProfession(raw)`,
 * which is exactly the pre-L6 key, so trust seeding degrades instead of
 * breaking.
 */
export async function professionKeyForTrade(
  client: TradeAliasQueryable,
  raw: string | null | undefined,
): Promise<string> {
  const normalized = normalizeProfession(raw ?? '');
  if (!normalized) return normalized;
  if (isStandardTradeKey(normalized)) return normalized;

  try {
    const row = await resolveTradeAlias(client, raw);
    if (!row) return normalized;
    return standardTradeKeyForCategory(row.trade_category) ?? row.trade_key;
  } catch (err) {
    console.warn('[trade-canonical] profession key lookup failed', {
      event: 'trade_profession_key_lookup_failed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    });
    return normalized;
  }
}
