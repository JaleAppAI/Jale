// Localized formatting for the `/pay-reference` (BLS OEWS) hint, shared by
// every surface that mounts `PayReferenceHint` (employer job forms, the
// worker profile page, the worker job detail page). Kept React-free, same
// discipline as `lib/pay.ts`: a pure function over the API payload plus a
// translator, unit-testable without a React/next-intl runtime.

import { TRADE_CATEGORIES } from '@/lib/job-form';
import type { PayTranslator } from '@/lib/pay';

/**
 * `trade_category` values `/pay-reference` can plausibly answer for.
 * `'other'` IS a valid `trade_category` (it's in `TRADE_CATEGORIES`), but the
 * backend has no reference row for it -- every request for it 404s
 * `no_reference` -- so it is excluded here rather than round-tripped to a
 * guaranteed failure. An empty string (no trade picked yet) is excluded too.
 */
const FETCHABLE_TRADES = new Set<string>(TRADE_CATEGORIES.filter((c) => c !== 'other'));

export function isFetchableTradeCategory(trade: string): boolean {
  return trade !== '' && FETCHABLE_TRADES.has(trade);
}

/** The `GET /pay-reference` 200 response shape. */
export interface PayReferencePayload {
  trade_category: string;
  p25_hourly: number;
  p50_hourly: number;
  p75_hourly: number;
  area_kind: 'metro' | 'nonmetro' | 'state';
  /** Human-readable place name -- a city ("Austin") for `metro`/`nonmetro`,
   *  a state ("Texas") for `state`. Already the right name for its kind, so
   *  the "in {area}" phrasing below never special-cases `area_kind` itself. */
  area_label: string;
  source_tier: string;
  data_vintage: string;
}

/**
 * Which surface is mounting the hint. Only changes the lead-in phrase --
 * `employer` frames the figures as a STARTING range for setting pay,
 * `worker-profile` frames them as what the worker's own trade typically
 * earns, `worker-job` frames them as a point of comparison sitting next to
 * this job's own listed pay (the component passes no job-pay figures of its
 * own; the comparison is visual, by placement, not a computed verdict).
 */
export type PayReferenceVariant = 'employer' | 'worker-profile' | 'worker-job';

export interface FormattedPayReference {
  /** Lead-in + range + median, one sentence, ready to render. */
  headline: string;
  /** The BLS/OEWS attribution line, rendered as its own (smaller) line. */
  source: string;
}

const VARIANT_INTRO_KEYS: Record<PayReferenceVariant, string> = {
  employer: 'reference_employer_intro',
  'worker-profile': 'reference_worker_profile_intro',
  'worker-job': 'reference_worker_job_intro',
};

/** The seed data carries cents; every displayed figure rounds to a whole
 *  dollar -- this is a rough market reference, not a payroll figure. */
function formatWholeDollar(n: number): string {
  return `$${Math.round(n)}`;
}

/**
 * Formats the "starting range" headline and its attribution line from a
 * `/pay-reference` payload.
 *
 * `tradeLabel` is the ALREADY-LOCALIZED trade name (e.g. `t('modal.trade.
 * electrician')` from the `employer_dashboard` namespace, which is the only
 * catalogue covering the full `trade_category` set including `drywall` and
 * `general_labor` -- `lib/trades.ts`'s `common.trades.*` only covers the
 * `WorkerTrade` subset). Passing it in, rather than resolving it here, keeps
 * this module free of any particular namespace choice and free of a second
 * next-intl translator instance.
 */
export function formatPayReference(
  payload: PayReferencePayload,
  t: PayTranslator,
  tradeLabel: string,
  variant: PayReferenceVariant = 'employer',
): FormattedPayReference {
  const intro = t(VARIANT_INTRO_KEYS[variant]);
  const range = t('reference_headline', {
    trade: tradeLabel,
    area: payload.area_label,
    min: formatWholeDollar(payload.p25_hourly),
    max: formatWholeDollar(payload.p75_hourly),
  });
  const median = t('reference_median', { amount: formatWholeDollar(payload.p50_hourly) });
  const source = t('reference_source', { vintage: payload.data_vintage });

  return { headline: `${intro} ${range} ${median}`, source };
}
