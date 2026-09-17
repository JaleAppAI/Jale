/**
 * Keyset paging, shared by every list that answers `?limit=&cursor=`.
 *
 * WHY KEYSET AND NOT OFFSET: an OFFSET page is defined by how many rows come
 * before it, so a row inserted (or re-sorted) between two requests makes the
 * reader skip a row or see one twice. These lists are ordered by timestamps
 * the product keeps changing -- a job posted, an application answered -- so
 * that is the normal case, not the pathological one. A cursor names the LAST
 * ROW OF THE PAGE instead, and the next page is everything strictly after it.
 *
 * WHY THE TUPLE: the cursor carries `(at, id)` and callers compare the pair,
 * `(sort_column, id) < ($1::timestamptz, $2::uuid)`. A bare `sort_column <`
 * would drop every row sharing the boundary timestamp, and two rows created in
 * the same microsecond is not a hypothetical.
 *
 * WHY `at` IS TEXT: the pg driver parses `timestamptz` into a JS `Date`, whose
 * millisecond resolution truncates Postgres's microseconds -- and a truncated
 * cursor no longer compares strictly-less than the row that produced it, so
 * that row comes back at the top of the next page, forever. Every caller casts
 * the column to text IN SQL and encodes that.
 */

import { isUuid } from './uuid';

export interface KeysetCursor {
  /** The sort column's value, as text at full database precision. */
  at: string;
  /** The tie-breaker: the row's id. */
  id: string;
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf-8').toString('base64');
}

/**
 * Never throws on malformed input -- a cursor is a client-supplied string, and
 * an unreadable one is a 400 for the caller to return, not a crash.
 *
 * `lastIndexOf` rather than `split`, because the ID half never contains a
 * separator: taking the last one is what keeps the id whole whatever precedes
 * it (a sort value carrying a '|' then fails `Date.parse` here rather than
 * quietly swallowing half of the id).
 */
export function decodeCursor(raw: string): KeysetCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const sepIdx = decoded.lastIndexOf('|');
  if (sepIdx <= 0 || sepIdx === decoded.length - 1) return null;
  const at = decoded.slice(0, sepIdx);
  const id = decoded.slice(sepIdx + 1);
  if (Number.isNaN(Date.parse(at))) return null;
  if (!isUuid(id)) return null;
  return { at, id };
}

/**
 * The page size to ask the database for, from the query string.
 *
 * Anything unreadable, zero or negative falls back to the default rather than
 * being refused: a nonsense `?limit=` is not worth an error page in front of a
 * list, and the cap is what actually protects the database.
 */
export function parseLimit(
  raw: string | undefined,
  bounds: { defaultLimit: number; maxLimit: number },
): number {
  if (!raw) return bounds.defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return bounds.defaultLimit;
  return Math.min(n, bounds.maxLimit);
}
