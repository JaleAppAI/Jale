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

/**
 * The subset of a hire's fields `hireTradeLabel`/`hireTradePhrase` read --
 * structurally satisfied by `Pick<ApplicationHire, 'trade'>` from `lib/api/worker.ts`,
 * which is NOT imported here for the reason the header gives (this module
 * imports nothing). `lib/__tests__/job-detail-display.test.ts` pins the
 * assignability with `tsc` so the two cannot drift apart.
 */
export type HireTradeFields = {
  trade?: {
    /** Raw `jobs.trade_category` (migration 023), or null. */
    category: string | null;
    /**
     * The employer's own words for `category === 'other'` (migration 077,
     * a different column from the 023 enum above), or null.
     */
    other: string | null;
    /** `trade_aliases.canonical_en` (migration 060), or null on a miss. */
    canonical_en: string | null;
    /** `trade_aliases.canonical_es` (migration 060), or null on a miss. */
    canonical_es: string | null;
  } | null;
};

/** The subset of a job's required-experience fields this module reads. */
export type ExperienceFields = {
  required_experience_years?: number | null;
  required_experience_months?: number | null;
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
 * The trade a worker was hired FOR, as a bare label meant to drop into a
 * sentence ("... te contrató como {trade}") -- not a standalone row.
 *
 * Translator contract: `tTrade` resolves the trade slug itself as a relative
 * key, exactly as in `tradeLabel`, and the caller scopes it to a catalogue
 * that has all eight of migration 023's tokens. Today that is
 * `employer_dashboard.modal.trade` (verified in `messages/en.json` and
 * `messages/es.json`); `common.trades` is NOT usable here -- it carries only
 * six, missing `drywall` and `general_labor`, so a drywall hire would render
 * a raw message key.
 *
 * Resolution order:
 *  - no trade object, or no `category` (null/undefined/blank) -> `null`.
 *  - any category but `'other'` -> `tTrade(category)`. The canonicals are
 *    ignored: only the catalogue follows the reader's locale, so a stale
 *    canonical pair must never beat it. No enum-membership check, same
 *    doctrine as `tradeLabel` -- the catalogue is the caller's concern.
 *  - `'other'` -> the canonical for the reader's locale (`es` -> `canonical_es`,
 *    anything else -> `canonical_en`), else the employer's own `other` text
 *    verbatim, else `null`.
 *
 * Unlike `tradeLabel`, `'other'` with nothing behind it is `null` rather than
 * `tTrade('other')`: this label goes INSIDE a sentence, and "...te contrató
 * como Otro" says nothing. The caller drops the clause instead.
 *
 * A half-populated canonical pair (one language set, the other null) is
 * defensive only -- migration 060 declares both `canonical_en` and
 * `canonical_es` NOT NULL -- so there is deliberately no cross-locale
 * fallback: an English label in a Spanish sentence is what the raw text
 * already gives, without pretending it was translated.
 */
export function hireTradeLabel(
  hire: HireTradeFields,
  locale: string,
  tTrade: Translator,
): string | null {
  return resolveHireTrade(hire, locale, tTrade)?.label ?? null;
}

/**
 * WHERE a resolved hire trade came from -- the one thing `hireTradePhrase`
 * needs that the label string itself cannot tell it.
 *
 * `'catalogue'` (a translated label) and `'canonical'` (a `trade_aliases`
 * hit) are OUR words for the trade, written the way a standalone label is
 * written: capitalised. `'employer'` is the employer's own free text, which
 * is theirs to capitalise however they typed it.
 */
type HireTradeSource = 'catalogue' | 'canonical' | 'employer';

/**
 * The resolution step behind BOTH `hireTradeLabel` and `hireTradePhrase`.
 *
 * The fallback ORDER (catalogue -> locale canonical -> employer text -> null)
 * lives here exactly once, so the two exported functions can never disagree
 * about which source won for a given hire -- only about how the winner is
 * capitalised. See `hireTradeLabel` for the order's rationale.
 */
function resolveHireTrade(
  hire: HireTradeFields,
  locale: string,
  tTrade: Translator,
): { label: string; source: HireTradeSource } | null {
  const trade = hire.trade;
  const category = trade?.category?.trim();
  if (!trade || !category) return null;

  if (category !== 'other') return { label: tTrade(category), source: 'catalogue' };

  // `tagFor` rather than `locale === 'es'`, so a regional tag ('es-MX') and
  // an unknown locale both fall the same way the module's other formatters do.
  const canonical = tagFor(locale).startsWith('es') ? trade.canonical_es : trade.canonical_en;
  const resolved = canonical?.trim();
  if (resolved) return { label: resolved, source: 'canonical' };

  const own = trade.other?.trim();
  return own ? { label: own, source: 'employer' } : null;
}

/**
 * `value` with its first character lower-cased for `tag`'s language, and
 * everything after it untouched.
 *
 * NOT `value.toLocaleLowerCase(tag)`: that would flatten the rest of a label
 * too ("Ayudante general" is fine, but a two-capital label would not be), and
 * this only ever needs to undo the leading capital a standalone label carries.
 *
 * Sliced by CODE POINT rather than `charAt(0)`, so a label opening on an
 * astral character is not cut in half mid-surrogate-pair. `codePointAt`
 * rather than string destructuring: this tsconfig sets no `target`/
 * `downlevelIteration`, so iterating a string is a `tsc` error here.
 */
function lowerFirstChar(value: string, tag: string): string {
  const code = value.codePointAt(0);
  if (code === undefined) return value;
  const first = String.fromCodePoint(code);
  // An acronym-led label ("HVAC technician") keeps its capital: when the
  // SECOND character is upper-case too, the first one is not a sentence-style
  // capital to undo, and "hVAC technician" would read as a typo. Ordinary
  // labels ("Electricista", "Tile setter") have a lower-case second character
  // and fold as before.
  const secondCode = value.codePointAt(first.length);
  if (secondCode !== undefined) {
    const second = String.fromCodePoint(secondCode);
    if (second !== second.toLocaleLowerCase(tag)) return value;
  }
  return first.toLocaleLowerCase(tag) + value.slice(first.length);
}

/**
 * `hireTradeLabel` for the middle of a sentence: catalogue and alias labels
 * lose their leading capital; the employer's own free text is returned
 * verbatim.
 *
 * The catalogue reads "Electricista" / "Welder" because a standalone tile is
 * where those labels are normally shown. Dropped into the hire copy as-is they
 * produce "te contrató como Electricista", which reads as a proper noun -- so
 * the words that are OURS (a translated label, a `trade_aliases` canonical)
 * are folded to "electricista".
 *
 * The employer's own words are NOT folded. "HVAC tech" lower-cased reads as a
 * typo, and this module has no way to tell an acronym from a sentence opener,
 * so free text is left exactly as it was typed.
 *
 * Same param contract, same locale handling and the same `null` cases as
 * `hireTradeLabel` (both delegate to one shared resolution step, so they
 * cannot pick different sources) -- see that function for the fallback order
 * and the `tTrade` namespace requirement.
 */
export function hireTradePhrase(
  hire: HireTradeFields,
  locale: string,
  tTrade: Translator,
): string | null {
  const resolved = resolveHireTrade(hire, locale, tTrade);
  if (!resolved) return null;

  return resolved.source === 'employer'
    ? resolved.label
    : lowerFirstChar(resolved.label, tagFor(locale));
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
 * Translated label for a job's required experience, WITH ITS UNIT.
 *
 * Three surfaces render this row -- the employer's job page, the worker's, and
 * the public one -- and only the public one ever said what the number meant.
 * The other two printed `String(required_experience_years)`, so a job asking
 * for three years' experience showed a bare "3" under an "Experience" label,
 * which reads as a score as easily as a duration.
 *
 * MONTHS IS THE CANONICAL TOTAL, NOT A REMAINDER. The two columns are not a
 * years-and-months pair; `required_experience_months` holds the WHOLE figure:
 *
 *  - `lib/job-form.ts` sends `required_experience_years` and no months field
 *    at all, and `infra/lambda/lib/job-fields.ts` stores
 *    `required_experience_months = months ?? years * 12`.
 *  - migration 033, which added the column, backfilled every legacy row as
 *    `LEAST(required_experience_years, 80) * 12`.
 *
 * So a three-year job is `(years: 3, months: 36)` on the wire, and reading the
 * pair as independent parts -- which this function and the public page's
 * `formatExperience` before it both did -- printed "3 years 36 months" on
 * every job that stated any experience at all.
 *
 * `years` is therefore a redundant legacy duplicate and is IGNORED whenever
 * `months` is present, with no special case for a pair that disagrees: months
 * is the column of record, and `(3, 0)` means zero months total however the
 * stale years column reads. It is only consulted as the `* 12` fallback for a
 * payload too old to carry months.
 *
 * ABSENT AND ZERO ARE DIFFERENT ANSWERS. Every call site guards the tile on
 * `!== null`, so a stated zero reaches the renderer and must say what it
 * means rather than print "0":
 *
 *  - no total derivable (both fields null/undefined) -> `null`. The job states
 *    no requirement; callers keep hiding the row.
 *  - a total of zero -> `tCommon('experience_none')`, the same "No experience
 *    required" sentence `ExperienceStepper` shows the employer while they set
 *    it. A negative total is impossible (migration 033 CHECKs 0..960) but
 *    degrades here rather than rendering "-1 years".
 *  - otherwise the total split into whole years and the leftover months, each
 *    non-zero part carrying its unit: "3 years", "6 months", "2 years
 *    6 months".
 *
 * `tCommon` is expected to be scoped to the `common` namespace, like
 * `durationLabel` and `workDayChips` -- the unit keys live there because all
 * three of these pages need them and none of them owns the others' namespace.
 */
export function experienceLabel(job: ExperienceFields, tCommon: Translator): string | null {
  const { required_experience_years: years, required_experience_months: months } = job;
  const total = months ?? (years == null ? null : years * 12);
  if (total == null) return null;
  if (total <= 0) return tCommon('experience_none');

  const wholeYears = Math.floor(total / 12);
  const leftoverMonths = total % 12;

  const parts: string[] = [];
  if (wholeYears) parts.push(tCommon('experience_years_unit', { n: wholeYears }));
  if (leftoverMonths) parts.push(tCommon('experience_months_unit', { n: leftoverMonths }));

  return parts.join(' ');
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
