// The access history's search: its URL parameters, their
// validation, and links. The page, its loader and the browser's search form
// all use it, so it imports nothing server-only.
//
// Values are checked here exactly as jale_audit.history_search checks them,
// so an invalid search is shown back to the admin and never reaches the
// database (where it would fail the page).
import {
  AUDIT_CATEGORIES,
  AUDIT_OUTCOMES,
  isUuid,
  type AuditCategory,
  type AuditOutcome,
} from './server/audit/codes';
import { localInputToIso } from './local-time';
import type { AccessHistoryEntry } from './types';

export const ACCESS_HISTORY_PATH = '/access-history';

/** A page's awaited searchParams. */
export type AccessHistorySearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The filter parameters, in the order links write them. */
const FILTER_PARAMS = ['subject', 'actor', 'record', 'from', 'to', 'category', 'outcome'] as const;
export type AccessHistoryFilterParam = (typeof FILTER_PARAMS)[number];
/** `before` is the paging cursor. */
export type AccessHistoryParam = AccessHistoryFilterParam | 'before';

export type AccessHistoryFilter = {
  subjectUserId?: string;
  actorId?: string;
  recordId?: string;
  /** Inclusive: an ISO instant with seconds and a zone. */
  from?: string;
  /** Exclusive: an ISO instant with seconds and a zone. */
  to?: string;
  category?: AuditCategory;
  outcome?: AuditOutcome;
};

/** A refused parameter, or 'range' when from is not before to. */
export type AccessHistoryProblem = AccessHistoryParam | 'range';

export type AccessHistoryQuery = {
  filter: AccessHistoryFilter;
  /** The previous page's last time: UTC text with microseconds. */
  before?: string;
  problems: AccessHistoryProblem[];
  /** What was typed, trimmed and capped, to fill the form again. */
  values: Partial<Record<AccessHistoryFilterParam, string>>;
};

export type AccessHistoryResult =
  | { status: 'preview' }
  | { status: 'forbidden' }
  | { status: 'invalid'; query: AccessHistoryQuery }
  | { status: 'ok'; query: AccessHistoryQuery; entries: AccessHistoryEntry[]; nextBefore?: string };

export const ACCESS_HISTORY_PROBLEMS: Readonly<Record<AccessHistoryProblem, string>> = {
  subject: 'Subject id must be a full id, 36 characters with dashes.',
  actor: 'Actor id must be a full id, 36 characters with dashes.',
  record: 'Record id must be a full id, 36 characters with dashes.',
  from: 'From must be a date and a time.',
  to: 'To must be a date and a time.',
  category: 'Choose a category from the list.',
  outcome: 'Choose an outcome from the list.',
  before: 'This page link no longer works. Start again from the newest entries.',
  range: 'The start of the time range must be before its end.',
};

const MAX_ECHO_LENGTH = 200;
const ID_KEYS = { subject: 'subjectUserId', actor: 'actorId', record: 'recordId' } as const;

// What history_search accepts: seconds, a fraction of up to six digits, and
// an explicit zone.
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;
// The cursor this page writes (HISTORY_SEARCH_SQL): UTC, six fraction digits.
const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  // Day 0 of the next month is the last day of this one.
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** An ISO instant with seconds, an explicit zone and a real calendar date. */
export function isAuditInstant(value: string): boolean {
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (match[8] !== 'Z' && (Number(match[9]) > 15 || Number(match[10]) > 59)) return false;
  return true;
}

/** A paging cursor as this page writes it. */
export function isHistoryCursor(value: string): boolean {
  return CURSOR_PATTERN.test(value) && isAuditInstant(value);
}

// An instant accepted by isAuditInstant as whole seconds since the epoch and
// microseconds within that second. Date.parse keeps milliseconds only, so it
// reads the instant without its fraction, which every engine reads exactly.
// The two parts stay apart because one number of microseconds would lose
// precision for late years the pattern accepts.
function instantParts(value: string): [seconds: number, micros: number] {
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return [Number.NaN, Number.NaN];
  const seconds = Date.parse(`${value.slice(0, 19)}${match[8]}`) / 1000;
  const micros = Number((match[7] ?? '.').slice(1).padEnd(6, '0'));
  return [seconds, micros];
}

/**
 * Orders two instants at microsecond precision, as history_search compares
 * them: below 0 when `a` is earlier, 0 for the same instant, above 0 when
 * `a` is later. Both must be instants isAuditInstant accepts.
 */
function compareInstants(a: string, b: string): number {
  const [aSeconds, aMicros] = instantParts(a);
  const [bSeconds, bMicros] = instantParts(b);
  return aSeconds === bSeconds ? aMicros - bMicros : aSeconds - bSeconds;
}

function isListed<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

/**
 * Reads the search from the URL. A refused value is named in `problems`
 * (never searched for); an empty one is no filter.
 */
export function parseAccessHistoryQuery(params: AccessHistorySearchParams): AccessHistoryQuery {
  const filter: AccessHistoryFilter = {};
  const problems: AccessHistoryProblem[] = [];
  const values: AccessHistoryQuery['values'] = {};
  let before: string | undefined;

  for (const name of [...FILTER_PARAMS, 'before'] as const) {
    const raw = params[name];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      // A repeated parameter is refused rather than guessed.
      problems.push(name);
      continue;
    }
    const value = raw.trim();
    if (!value) continue;
    if (name !== 'before') values[name] = value.slice(0, MAX_ECHO_LENGTH);

    switch (name) {
      case 'subject':
      case 'actor':
      case 'record':
        if (isUuid(value)) filter[ID_KEYS[name]] = value.toLowerCase();
        else problems.push(name);
        break;
      case 'from':
      case 'to':
        if (isAuditInstant(value)) filter[name] = value;
        else problems.push(name);
        break;
      case 'category':
        if (isListed(AUDIT_CATEGORIES, value)) filter.category = value;
        else problems.push(name);
        break;
      case 'outcome':
        if (isListed(AUDIT_OUTCOMES, value)) filter.outcome = value;
        else problems.push(name);
        break;
      case 'before':
        if (isHistoryCursor(value)) before = value;
        else problems.push(name);
        break;
    }
  }

  // from is inclusive and to exclusive, so equal ends would match nothing.
  // Anything but a start strictly before the end is refused.
  if (filter.from && filter.to && !(compareInstants(filter.from, filter.to) < 0)) {
    problems.push('range');
  }

  return { filter, ...(before ? { before } : {}), problems, values };
}

/** The link to a search, and to one of its older pages when `before` is given. */
export function accessHistoryHref(filter: AccessHistoryFilter, before?: string): string {
  const params = new URLSearchParams();
  const entries: [AccessHistoryParam, string | undefined][] = [
    ['subject', filter.subjectUserId],
    ['actor', filter.actorId],
    ['record', filter.recordId],
    ['from', filter.from],
    ['to', filter.to],
    ['category', filter.category],
    ['outcome', filter.outcome],
    ['before', before],
  ];
  for (const [name, value] of entries) {
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return query ? `${ACCESS_HISTORY_PATH}?${query}` : ACCESS_HISTORY_PATH;
}

/**
 * The link for the search form's fields. `fromLocal` and `toLocal` are
 * datetime-local values in the viewer's zone and become instants; empty
 * fields drop out. The page checks every value again.
 */
export function accessHistorySearchHref(fields: Readonly<Record<string, unknown>>): string {
  const text = (name: string) => {
    const value = fields[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const params = new URLSearchParams();
  const entries: [AccessHistoryFilterParam, string | undefined][] = [
    ['subject', text('subject')],
    ['actor', text('actor')],
    ['record', text('record')],
    ['from', localInputToIso(text('fromLocal'))],
    ['to', localInputToIso(text('toLocal'))],
    ['category', text('category')],
    ['outcome', text('outcome')],
  ];
  for (const [name, value] of entries) {
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return query ? `${ACCESS_HISTORY_PATH}?${query}` : ACCESS_HISTORY_PATH;
}
