// application-hire-view.ts
//
// The READ-side view for the sprint-24 worker hire celebration: the `hire`
// object `GET /worker/applications` attaches to a hired row, and the only
// place its shape is decided.
//
// Pure by construction -- no `PoolClient`, no GUC, no clock, no locale input.
// It re-shapes columns the caller has ALREADY selected (the same reasoning
// `application-stage-view.ts` opens with: a per-row round trip would turn one
// SELECT into N+1), so every field is `unknown`-tolerant and a missing or
// NULL column degrades to `null` rather than throwing. A celebration modal is
// the worst possible place for a 500.
//
// ── WHICH COLUMN, NOT WHAT COPY ──
// The celebration repeats the job's start date, location, pay and shift
// beneath "You've been hired", and two of those facts are stored twice:
// location as both `jobs.location` free text and the 065 `city`/`state` pair,
// pay as both the `jobs.pay` string `formatPayRange()` wrote at create time
// and the 023/033 `pay_min`/`pay_max`/`pay_interval` triple. "Which column do
// I read?" IS a server decision with one answer -- so `location` is resolved
// here, once, rather than re-derived by every client.
//
// Composing worker-facing COPY is not. The pay line is rendered by the
// frontend's own `formatPay(job, t)` (frontend/src/lib/pay.ts), which is
// next-intl-aware and already formats these exact four fields for the worker
// job card, the job detail page and the public job page. This endpoint takes
// no locale input, so anything it synthesised would be English ("up to $26")
// in a Spanish-facing modal, and would give one job two different pay lines on
// two screens. Hence: `pay` is the stored string or null -- NEVER built -- and
// the structured triple travels raw. `formatPayRangeLocalized`
// (lib/job-fields.ts) is not reused for the same reason: it needs a locale
// nothing here has.

/**
 * The columns a caller must have selected, with the `job_`-prefixed aliases
 * `worker-applications-list.ts` gives the `jobs` side. The prefix is not
 * cosmetic: it keeps these out of the response by making them explicit keys
 * to strip, and it removes any doubt about which table a value came from.
 */
export interface HireRow {
  /** COALESCE(job_applications.hired_at, job_applications.updated_at). */
  hired_at?: unknown;
  hired_seen_at?: unknown;
  hired_ack_at?: unknown;
  /** to_char(jobs.start_date, 'YYYY-MM-DD') -- a string, never a Date. */
  job_start_date?: unknown;
  job_location?: unknown;
  job_city?: unknown;
  job_state?: unknown;
  job_pay?: unknown;
  job_pay_min?: unknown;
  job_pay_max?: unknown;
  job_pay_interval?: unknown;
  job_shift_schedule?: unknown;
}

/** The `hire` object, exactly as the frontend lane consumes it. */
export interface HireSummary {
  /** ISO timestamp. Never null -- see `buildHireSummary`'s return contract. */
  hired_at: string;
  /** The celebration modal has been shown (server-side, so it holds across devices). */
  seen_at: string | null;
  /** The banner has been dismissed. */
  acknowledged_at: string | null;
  start_date: string | null;
  location: string | null;
  /**
   * The stored `jobs.pay` free text, trimmed, or null. Never synthesised from
   * the bounds below -- see the header. The frontend's `formatPay` prefers the
   * structured triple and falls back to this string, and it already screens
   * the API's "Pay not specified" sentinel, so this passes through verbatim.
   */
  pay: string | null;
  /** 023 `jobs.pay_min` (INTEGER), for the client's own formatter. */
  pay_min: number | null;
  /** 023 `jobs.pay_max` (INTEGER). */
  pay_max: number | null;
  /** 033 `jobs.pay_interval`, raw: 'hourly'|'daily'|'weekly'|'monthly'|'fixed'. */
  pay_interval: string | null;
  shift_schedule: string | null;
}

/** A trimmed non-blank string, or null. The shape every text field takes. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * An ISO string, or null. `pg` returns a timestamptz as a JS `Date`, but a
 * caller that has already stringified (or a JSON round trip) must produce the
 * same payload -- so both are accepted and normalized to one form rather than
 * left to `JSON.stringify` to handle differently per input type.
 */
function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** A finite number from an INTEGER column, whatever type-parser is in play. */
function amount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `"city, state"` when BOTH parts are present, else the free-text
 * `jobs.location`, else null. The pair wins because it is the normalized one
 * (065 backfilled it FROM the free text and 067 repaired it), and a row where
 * only one half parsed is not a location -- "El Paso, " reads as a bug.
 */
function hireLocation(row: HireRow): string | null {
  const city = text(row.job_city);
  const state = text(row.job_state);
  if (city && state) return `${city}, ${state}`;
  return text(row.job_location);
}

/**
 * The `hire` object for a row whose status is `hired`, or null when the row
 * carries no hire timestamp at all.
 *
 * That null is unreachable from the database: the endpoint selects
 * `COALESCE(hired_at, updated_at)` and `job_applications.updated_at` is
 * NOT NULL (003), so every hired row has one. It exists so a row that somehow
 * lacks it is answered with NO celebration rather than with
 * `hired_at: null` -- which the frontend contract does not allow, and which
 * would render an empty date under "You've been hired".
 */
export function buildHireSummary(row: HireRow): HireSummary | null {
  const hiredAt = isoTimestamp(row.hired_at);
  if (!hiredAt) return null;

  return {
    hired_at: hiredAt,
    seen_at: isoTimestamp(row.hired_seen_at),
    acknowledged_at: isoTimestamp(row.hired_ack_at),
    start_date: text(row.job_start_date),
    location: hireLocation(row),
    // Raw, all four. The client formats them; see the header.
    pay: text(row.job_pay),
    pay_min: amount(row.job_pay_min),
    pay_max: amount(row.job_pay_max),
    pay_interval: text(row.job_pay_interval),
    shift_schedule: text(row.job_shift_schedule),
  };
}
