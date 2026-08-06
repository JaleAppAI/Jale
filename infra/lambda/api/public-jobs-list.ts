import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPublicJobsDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

/**
 * GET /public/jobs
 *
 * Unauthenticated index of publicly-listed active jobs, for SEO crawling and
 * a public job-search page. Connects as jale_public_jobs (see lib/db.ts
 * getPublicJobsDbPool), same as public-job.ts. NEVER calls setRlsContext --
 * there is no Cognito sub on this route.
 *
 * status = 'active' is explicit in the WHERE clause below even though the
 * jobs_public_read RLS policy already restricts rows to
 * public_listing_enabled = true: that policy does not check status, so a
 * paused/closed-but-still-listed job would otherwise leak into this index.
 */

const CORS_HEADERS = corsHeaders();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// id is selected only to build the keyset cursor -- it is never returned in
// the response body. cursor_created_at is created_at cast to text at full
// Postgres precision (microseconds): the pg driver parses timestamptz into a
// JS Date, and Date's millisecond resolution would silently truncate a
// microsecond-precision created_at, letting a row re-appear on the next page
// because it no longer compares strictly-less than the cursor it produced.
const PUBLIC_JOBS_LIST_COLUMNS = `
  id, public_code AS code, title, city, state_region, trade_category,
  created_at, updated_at, created_at::text AS cursor_created_at
`;

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf-8').toString('base64');
}

/** Never throws on malformed input -- an invalid cursor is a 400, not a crash. */
function decodeCursor(raw: string): Cursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf-8');
  } catch {
    return null;
  }
  const sepIdx = decoded.lastIndexOf('|');
  if (sepIdx <= 0 || sepIdx === decoded.length - 1) return null;
  const createdAt = decoded.slice(0, sepIdx);
  const id = decoded.slice(sepIdx + 1);
  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (!UUID_RE.test(id)) return null;
  return { createdAt, id };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const limit = parseLimit(event.queryStringParameters?.limit);

    const rawCursor = event.queryStringParameters?.cursor;
    let cursor: Cursor | null = null;
    if (rawCursor) {
      cursor = decodeCursor(rawCursor);
      if (!cursor) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_cursor' }) };
      }
    }

    const pool = await getPublicJobsDbPool();
    client = await pool.connect();

    const params: unknown[] = [];
    let where = `status = 'active' AND public_listing_enabled = true`;
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      // Keyset pagination on (created_at, id) DESC: strictly-less on the tuple
      // is exactly "everything after the last row of the previous page".
      where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    // Fetch one extra row to detect whether a next page exists, without a
    // separate COUNT query.
    params.push(limit + 1);

    const result = await client.query(
      `SELECT ${PUBLIC_JOBS_LIST_COLUMNS}
         FROM jobs
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const jobs = page.map((row: any) => ({
      code: row.code,
      title: row.title,
      city: row.city,
      state_region: row.state_region,
      trade_category: row.trade_category,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const last = page[page.length - 1];
    // Built from cursor_created_at (a text cast done in SQL), never from
    // last.created_at (a JS Date once the pg driver parses it) -- see the
    // column-list comment above.
    const nextCursor = hasMore && last
      ? encodeCursor(String(last.cursor_created_at), last.id)
      : null;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ jobs, next_cursor: nextCursor }),
    };
  } catch (err) {
    console.error('public-jobs-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
