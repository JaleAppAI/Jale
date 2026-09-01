/**
 * Trade labelling — one implementation, one message catalogue.
 *
 * The `WorkerTrade` enum (`lib/api/worker.ts`) is written by three different
 * surfaces (web register, WhatsApp onboarding, the profile editor) and read by
 * at least as many, so the enum→label mapping is exactly the kind of thing that
 * silently forks. It lives here, against `common.trades.*`, rather than being
 * re-declared per page against a page-local namespace.
 */

import type { WorkerTrade } from '@/lib/api/worker';
import { STANDARD_TRADE_KEYS } from '@/lib/worker-vocab';

/**
 * The shape this helper needs from a next-intl translator: a callable that
 * turns a key into a string. Callers pass `useTranslations('common')`.
 *
 * Structural rather than `ReturnType<typeof useTranslations>` so the helper is
 * unit-testable without a React/next-intl runtime.
 */
export type CommonTranslator = (key: string) => string;

/**
 * Enum members that have their own label — the shared worker vocabulary's
 * standard five, not a second copy of them. `other` is deliberately absent
 * (that is why this reads `STANDARD_TRADE_KEYS` and not `TRADE_KEYS`): it is
 * not a trade, it is a pointer at `main_trade_other`, and the branch below
 * handles it before this list is ever consulted.
 */
const KNOWN_TRADES: readonly string[] = STANDARD_TRADE_KEYS;

/**
 * Translated label for a worker's main trade.
 *
 * - no trade recorded -> `common.trades.unspecified` ("Trade not specified"),
 *   never a blank or a dash;
 * - `other` -> the worker's own words, falling back to `common.trades.other`
 *   when they left the free-text field empty;
 * - a value outside the enum (an older row, or a backend that grew a trade the
 *   web app has not learned yet) is shown verbatim. Inventing a label for it,
 *   or hiding it behind "unspecified", would both be lies.
 *
 * `trade` is typed loosely because the two API modules disagree: `worker.ts`
 * narrows it to `WorkerTrade`, `employer.ts` types the same column as `string`.
 */
export function tradeLabel(
    t: CommonTranslator,
    trade: WorkerTrade | string | null | undefined,
    tradeOther?: string | null,
): string {
    if (!trade) return t('trades.unspecified');
    if (trade === 'other') return tradeOther?.trim() || t('trades.other');
    if (KNOWN_TRADES.includes(trade)) return t(`trades.${trade}`);
    return trade;
}
