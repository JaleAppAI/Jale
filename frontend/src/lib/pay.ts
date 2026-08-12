// Localized pay formatting, shared by the worker job feed, the worker job
// detail page, and the public job page.
//
// `jobs.pay` is a server-persisted, English-only free-text string (e.g.
// "From $15", "$15-$20") that used to be shown verbatim to Spanish-speaking
// workers. Every job payload also carries the structured `pay_min`/
// `pay_max`/`pay_interval` columns (023/033) -- this module formats a
// localized string from those instead, falling back to the legacy `pay`
// string only when none of the structured fields are present (an older
// payload, or a job created before the structured columns existed).

/** The subset of job fields this module reads. `Job`/`JobDetail`
 * (`lib/api/worker.ts`) and `PublicJobActive` (`lib/api/publicJob.ts`) both
 * satisfy this shape. */
export interface PayFields {
  pay?: string | null;
  pay_min?: number | null;
  pay_max?: number | null;
  pay_interval?: string | null;
}

/** The API's sentinel for "the employer did not state a rate". Not a figure.
 * Mirrors the same constant duplicated at each legacy `.pay` call site. */
export const PAY_UNSPECIFIED = 'Pay not specified';

/**
 * A next-intl translator already scoped to the `pay` namespace (either
 * `useTranslations('pay')` client-side or
 * `getTranslations({ locale, namespace: 'pay' })` server-side -- both
 * produce a callable assignable to this shape). The `values` type mirrors
 * next-intl's own `TranslationValues` (string | number | Date).
 */
export type PayTranslator = (key: string, values?: Record<string, string | number | Date>) => string;

const INTERVAL_UNIT_KEYS: Record<string, string> = {
  hourly: 'interval_hourly',
  daily: 'interval_daily',
  weekly: 'interval_weekly',
  monthly: 'interval_monthly',
};

/** `$15`, `$15.50` -- whole dollars render with no decimal, fractional
 * amounts round to cents. Matches the plain-figure style of the legacy
 * `pay` strings this replaces. */
function formatAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** `/hr`, `/día`, ` (fixed)`, ` (fijo)` -- appended after the amount(s).
 * `fixed` and any unmapped interval other than the four known recurring
 * ones get no slash (a fixed-price job isn't "per" anything); an
 * unrecognized interval string is treated the same as no interval. */
function intervalSuffix(interval: string | null | undefined, t: PayTranslator): string {
  if (!interval) return '';
  if (interval === 'fixed') return ` (${t('interval_fixed')})`;
  const key = INTERVAL_UNIT_KEYS[interval];
  return key ? `/${t(key)}` : '';
}

/**
 * Formats a localized pay string from a job's structured pay fields.
 *
 * - min only -> "From $15" / "Desde $15"
 * - max only -> "Up to $20" / "Hasta $20"
 * - both -> "$15–$20"
 * - any of the above + a known recurring interval -> suffixed, e.g. "$15–$20/hr"
 * - any of the above + `pay_interval: 'fixed'` -> suffixed, e.g. "$15 (fixed)"
 * - min AND max both null/undefined -> falls back to the legacy `pay`
 *   string (if present and not the API's "not specified" sentinel)
 * - nothing at all -> `null`; callers keep their existing
 *   "pay not specified" behavior (hiding the row) for that case.
 */
export function formatPay(job: PayFields, t: PayTranslator): string | null {
  const { pay_min, pay_max, pay_interval } = job;

  if (pay_min == null && pay_max == null) {
    if (job.pay && job.pay !== PAY_UNSPECIFIED) return job.pay;
    return null;
  }

  let base: string;
  if (pay_min != null && pay_max != null) {
    base = t('range', { min: formatAmount(pay_min), max: formatAmount(pay_max) });
  } else if (pay_min != null) {
    base = t('from', { amount: formatAmount(pay_min) });
  } else {
    base = t('up_to', { amount: formatAmount(pay_max as number) });
  }

  return `${base}${intervalSuffix(pay_interval, t)}`;
}
