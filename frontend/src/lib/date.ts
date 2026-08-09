/**
 * Every human-readable date and time in the app is formatted here.
 *
 * Two mistakes kept being re-made at individual call sites, which is why this
 * module exists rather than a `toLocaleDateString` per page:
 *
 *  1. `Intl.DateTimeFormat(undefined, …)` and the bare `toLocaleDateString()`
 *     resolve to the RUNTIME's locale, not the app's. A reader on a Spanish
 *     page with an English browser got English dates.
 *  2. A date-only value formatted in the reader's timezone shifts by a day.
 *     `new Date('2026-06-15')` is UTC midnight, so a reader at UTC-6 sees
 *     "June 14".
 *
 * The fix for (2) depends on what the value MEANS, so the helpers below come in
 * two families and the naming keeps them apart:
 *
 *  - DATE-ONLY values (`YYYY-MM-DD`: a job's `start_date`) name a calendar day
 *    with no timezone. They are formatted with `timeZone: 'UTC'`, which is the
 *    only way the printed day matches the stored one everywhere on earth.
 *
 *  - INSTANTS (ISO timestamps: `created_at`, `applied_at`, `uploaded_at`,
 *    `last_message_at`) name a moment. They are formatted in the READER's
 *    timezone, because "applied Jun 15" should mean Jun 15 where the reader is.
 *    Pinning these to UTC would be the same bug pointing the other way.
 *
 * Server components have no reader timezone to resolve, so instants rendered on
 * the server come out in the server's zone (UTC in Lambda). That is the honest
 * answer for a page rendered before anyone requests it.
 *
 * Fallbacks are uniform: `null` for an empty input, and for a date that cannot
 * be parsed the raw input is handed back rather than "Invalid Date" -- call
 * sites lean on that with `?? value`. `formatTimeOfDay` is the exception: an
 * unparseable value has no sensible time to echo, so it returns `null`.
 */

/**
 * The app's locales (`en`, `es`) mapped to the regional tags the formatter
 * should use. `es-MX` rather than bare `es` because the audience is Mexican;
 * bare `es` resolves to Spain's conventions. Previously spelled out as
 * `locale === 'es' ? 'es-MX' : 'en-US'` at three separate call sites.
 */
const LOCALE_TAGS: Record<string, string> = {
  es: 'es-MX',
  en: 'en-US',
};

const FALLBACK_TAG = 'en-US';

function tagFor(locale: string): string {
  return LOCALE_TAGS[locale] ?? FALLBACK_TAG;
}

type DateInput = string | number | Date | null | undefined;

/** `null` when there is nothing to format, `Invalid Date` when it will not parse. */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? value : new Date(value);
}

/** What a caller gets back when the value would not parse: the value itself. */
function rawOf(value: DateInput): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? null : String(value);
}

function format(
  value: DateInput,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const parsed = toDate(value);
  if (parsed === null) return null;
  if (Number.isNaN(parsed.getTime())) return rawOf(value);
  return new Intl.DateTimeFormat(tagFor(locale), options).format(parsed);
}

/* ===== Date-only values (YYYY-MM-DD) -- formatted in UTC ================== */

/**
 * A job's start date, long form: "June 15, 2026" / "15 de junio de 2026".
 *
 * Named for its one caller-facing meaning rather than its shape, because that
 * is what stops it being reached for with a timestamp -- feeding an instant
 * through here forces it onto its UTC calendar day, which is a day late for
 * anything created after 18:00 in Mexico. Use `formatLongDate` for those.
 */
export function formatStartDate(value: DateInput, locale: string): string | null {
  return format(value, locale, {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** A date-only value, short form: "Jun 15" / "15 jun". */
export function formatStartDateShort(value: DateInput, locale: string): string | null {
  return format(value, locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* ===== Instants (ISO timestamps) -- formatted in the reader's timezone ==== */

/** "Jun 15" / "15 jun" -- for lists where the year is obvious from context. */
export function formatShortDate(value: DateInput, locale: string): string | null {
  return format(value, locale, { month: 'short', day: 'numeric' });
}

/** "Jun 15, 2026" / "15 jun 2026" -- the default for a date shown on its own. */
export function formatLongDate(value: DateInput, locale: string): string | null {
  return format(value, locale, { dateStyle: 'medium' });
}

/** "Jun 15, 2026, 2:30 PM" -- when the time of day carries meaning too. */
export function formatDateTime(value: DateInput, locale: string): string | null {
  return format(value, locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Monday, Jun 15" -- the dashboard's "today" line. */
export function formatWeekdayDate(value: DateInput, locale: string): string | null {
  return format(value, locale, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * "2:30 PM" / "14:30" -- a message timestamp inside a transcript, where the
 * day is already established by the thread around it.
 *
 * Returns `null` rather than the raw value for an unparseable input: echoing an
 * ISO string into a slot sized for a clock time would be worse than blank.
 */
export function formatTimeOfDay(value: DateInput, locale: string): string | null {
  const parsed = toDate(value);
  if (parsed === null || Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(tagFor(locale), {
    hour: 'numeric', minute: '2-digit',
  }).format(parsed);
}
