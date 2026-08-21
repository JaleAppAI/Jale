/**
 * Display formatters for a job's structured fields (trade, duration, and
 * shift schedule), with legacy free-text fallback. Shared by the worker job
 * detail page, the public SEO job page, and (later) the feed card -- the
 * three surfaces that currently each re-derive this by hand.
 *
 * `jobs.trade_category` / `expected_duration` / `shift_schedule` used to be
 * server-persisted free text, shown verbatim. The structured columns
 * (`trade_category` as an enum + `trade_category_other`, `expected_duration_bucket`,
 * `work_days`, `shift_start`/`shift_end`) let the app render a localized label
 * instead -- this module formats those, falling back to the legacy string
 * only when none of the structured fields are present. Same shape as
 * `lib/pay.ts`'s split between structured `pay_min`/`pay_max` and legacy `pay`.
 *
 * Pure and locale-agnostic by design: every formatter takes a narrow
 * structural param type (satisfied by `Job`/`JobDetail` in `lib/api/worker.ts`
 * and `PublicJobActive` in `lib/api/publicJob.ts`, without importing either)
 * plus translator function(s) the caller already scoped with `useTranslations`
 * or `getTranslations`. Nothing here imports `next-intl` or reads a message
 * catalogue directly, so it is unit-testable with a stub translator and
 * reusable from server components.
 */

/** The subset of a job's trade fields this module reads. */
export type TradeFields = {
  trade_category?: string | null;
  trade_category_other?: string | null;
};

/** The subset of a job's schedule/duration fields this module reads. */
export type ScheduleFields = {
  expected_duration?: string | null;
  expected_duration_bucket?: string | null;
  shift_schedule?: string | null;
  work_days?: readonly string[] | null;
  shift_start?: string | null;
  shift_end?: string | null;
};

/**
 * The shape this module needs from a next-intl translator: a callable that
 * turns a (relative) key into a string, with optional interpolation values.
 * Structural rather than next-intl's own type so these formatters are
 * unit-testable without a React/next-intl runtime -- mirrors `PayTranslator`
 * in `lib/pay.ts`.
 */
export type Translator = (key: string, values?: Record<string, unknown>) => string;

/**
 * The app's locales (`en`, `es`) mapped to the regional tags `Intl` should
 * use. Duplicated from `lib/date.ts` rather than imported: `date.ts` keeps
 * `LOCALE_TAGS`/`tagFor` module-private, and this module stays decoupled from
 * it the same way `lib/pay.ts` stays decoupled from `lib/api/worker` --
 * structural typing and small local duplication over a cross-module
 * dependency between two otherwise-independent pure formatters.
 */
const LOCALE_TAGS: Record<string, string> = {
  es: 'es-MX',
  en: 'en-US',
};
const FALLBACK_TAG = 'en-US';

function tagFor(locale: string): string {
  return LOCALE_TAGS[locale] ?? FALLBACK_TAG;
}

/**
 * Translated label for a job's trade category.
 *
 * Translator contract (deliberately two translators, both caller-scoped):
 *  - `tTrade` resolves the trade *slug itself* as a relative key --
 *    `tTrade(job.trade_category)`, e.g. `tTrade('electrician')` or
 *    `tTrade('other')`. The caller scopes this to wherever that page's job
 *    trade-category catalogue lives (job trade categories are a different,
 *    larger enum than a worker's own `common.trades.*` -- e.g.
 *    `useTranslations('worker_job_detail.trade')` or
 *    `useTranslations('public_job.trade')`).
 *  - `tDetail` resolves the fixed relative key `'trade_with_other'` with an
 *    `{ other }` interpolation value, scoped to the page namespace itself
 *    (`worker_job_detail` / `public_job` per the task's key convention).
 *
 * Behavior:
 *  - no `trade_category` at all (null/undefined/empty) -> `null`, so callers
 *    keep their existing "hide the row" behavior.
 *  - `trade_category === 'other'` with non-blank `trade_category_other` ->
 *    `tDetail('trade_with_other', { other: <trimmed text> })`.
 *  - `trade_category === 'other'` with blank/absent free text, or any other
 *    (known or unrecognized) trade slug -> `tTrade(trade_category)`.
 *
 * Unlike `lib/trades.ts`'s `tradeLabel` (which validates against the
 * `WorkerTrade` enum and echoes an unrecognized value verbatim), this makes
 * no enum-membership check: the job trade-category catalogue is the calling
 * page's translator's concern, not this pure formatter's. Keeping the
 * KNOWN_TRADES allowlist out of this module also avoids importing
 * `job-form.ts`'s `TRADE_CATEGORIES` (a much heavier module) into a formatter
 * meant to stay reusable and dependency-light.
 */
export function tradeLabel(job: TradeFields, tTrade: Translator, tDetail: Translator): string | null {
  const trade = job.trade_category;
  if (!trade) return null;

  if (trade === 'other') {
    const other = job.trade_category_other?.trim();
    if (other) return tDetail('trade_with_other', { other });
  }

  return tTrade(trade);
}

/**
 * Translated label for a job's expected duration.
 *
 * - `expected_duration_bucket` present (non-blank) -> `tCommon('duration_bucket.<bucket>')`.
 * - otherwise -> the legacy `expected_duration` free-text string, trimmed, or
 *   `null` when that is absent/blank too.
 *
 * `tCommon` is expected to be scoped to the `common` namespace
 * (`useTranslations('common')`), since `duration_bucket.*` lives there per
 * the shared translation-key convention.
 */
export function durationLabel(job: ScheduleFields, tCommon: Translator): string | null {
  const bucket = job.expected_duration_bucket?.trim();
  if (bucket) return tCommon(`duration_bucket.${bucket}`);

  const legacy = job.expected_duration?.trim();
  return legacy || null;
}

/**
 * Canonical week order for rendering work-day chips. Values outside this set
 * (stale/unexpected data) are silently dropped rather than shown raw -- a
 * chip has no sensible fallback shape for an arbitrary string the way a
 * trade or duration label can echo raw text.
 */
const CANONICAL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * Localized short day-of-week labels for a job's `work_days`, always in
 * canonical mon..sun order regardless of the input array's order (a job
 * built server-side or by a different form might list them in any order).
 *
 * Returns `[]` when `work_days` is absent or empty, so callers can render
 * nothing rather than an empty chip row.
 *
 * `tCommon` is expected to be scoped to the `common` namespace; each present
 * day is resolved via `tCommon('work_days.<day>')`.
 */
export function workDayChips(job: ScheduleFields, tCommon: Translator): string[] {
  if (!job.work_days || job.work_days.length === 0) return [];
  const present = new Set(job.work_days);
  return CANONICAL_DAYS.filter((day) => present.has(day)).map((day) => tCommon(`work_days.${day}`));
}

/**
 * `'07:00'` -> a UTC `Date` on a fixed nominal day, or `null` if unparseable.
 *
 * Tolerates an optional `:SS` (and fractional seconds): `shift_start`/
 * `shift_end` are Postgres `TIME` columns (migration 077), and this repo
 * registers no custom node-postgres type parsers (documented precedent:
 * `lib/pay-reference.ts`'s `WageReferenceRow` comment on NUMERIC/OID 1700),
 * so a `TIME` value crosses the wire as `HH:MM:SS` by the driver's default,
 * not the bare `HH:MM` a hand-typed test fixture might suggest.
 */
function timeToUtcDate(value: string): Date | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return new Date(Date.UTC(2000, 0, 1, hour, minute));
}

/**
 * Localized shift-hours range, e.g. "7:00 AM – 4:00 PM" (en) or a
 * locale-appropriate equivalent (es).
 *
 * `shift_start`/`shift_end` are wall-clock times (`HH:MM`) with no timezone
 * of their own -- like a date-only value in `lib/date.ts`, "7:00 AM" is
 * meant to mean the same thing everywhere the job is read, not shift with
 * the reader's offset. So each side is anchored to a fixed UTC instant and
 * formatted with `timeZone: 'UTC'`, mirroring `date.ts`'s date-only
 * treatment (and its `LOCALE_TAGS` mapping) rather than the instant-value
 * helpers that intentionally resolve in the reader's zone.
 *
 * Returns `null` when either side is missing or unparseable -- a half-open
 * range ("starts at 7:00 AM" with no end) isn't this function's shape; a
 * future task can add a one-sided formatter if the design calls for it.
 */
export function shiftHoursLabel(job: ScheduleFields, locale: string): string | null {
  if (!job.shift_start || !job.shift_end) return null;

  const start = timeToUtcDate(job.shift_start);
  const end = timeToUtcDate(job.shift_end);
  if (!start || !end) return null;

  const formatter = new Intl.DateTimeFormat(tagFor(locale), { timeStyle: 'short', timeZone: 'UTC' });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

/**
 * Combined convenience for the schedule row: work-day chips, a shift-hours
 * range, and the legacy `shift_schedule` string -- with `legacy` populated
 * ONLY when no structured schedule data exists at all (no `work_days`, and
 * neither `shift_start` nor `shift_end`). If the job has any structured
 * schedule data -- even a one-sided shift with no matching end/start --
 * `legacy` is suppressed in favor of showing whatever structured pieces are
 * available, rather than mixing an old free-text description with a
 * partially-structured render.
 *
 * `tCommon` is passed straight through to `workDayChips` (see its doc
 * comment for the namespace contract); `locale` is passed straight through
 * to `shiftHoursLabel`.
 */
export function scheduleSummary(
  job: ScheduleFields,
  locale: string,
  tCommon: Translator,
): { days: string[]; hours: string | null; legacy: string | null } {
  const hasStructured = Boolean(job.work_days && job.work_days.length > 0)
    || Boolean(job.shift_start?.trim())
    || Boolean(job.shift_end?.trim());

  return {
    days: workDayChips(job, tCommon),
    hours: shiftHoursLabel(job, locale),
    legacy: hasStructured ? null : (job.shift_schedule?.trim() || null),
  };
}
