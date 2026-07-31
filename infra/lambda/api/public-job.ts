import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPublicJobsDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeCode, isValidJobCode, isValidShareCode, hashVisitor } from '../lib/referral-codes';
import { getVisitorSalt } from '../lib/referral-secrets';

/**
 * GET /public/jobs/{code}
 *
 * Unauthenticated. Connects as jale_public_jobs (see lib/db.ts getPublicJobsDbPool).
 * NEVER calls setRlsContext -- there is no Cognito sub on this route. Access
 * control is the jobs_public_read RLS policy plus the column-scoped GRANT from
 * migration 056, not handler discipline.
 */

const CORS_HEADERS = corsHeaders();

type DeviceKind = 'mobile' | 'tablet' | 'desktop' | 'unknown';

// Column list matches exactly the GRANT SELECT (...) ON jobs TO jale_public_jobs
// list in migration 056. employer_id and the geo columns from 009 are
// deliberately absent from that grant and must never be added here.
const PUBLIC_JOB_COLUMNS = `
  id, public_code AS code, title, company, location, job_type, description,
  pay, pay_min, pay_max, pay_interval, start_date, expected_duration,
  shift_schedule, trade_category, required_experience_years,
  required_experience_months, certifications, language_preference,
  transportation_required, work_authorization_required,
  number_of_workers_needed, required_docs, status, created_at
`;

/**
 * Link-preview fetchers, not people. A share into WhatsApp triggers Meta's
 * crawler immediately, so counting these would inflate a worker's open count
 * before any human clicks. Deliberately conservative: an unmatched bot is
 * counted as a visit, which is the safer error.
 */
const PREVIEW_CRAWLERS = /facebookexternalhit|whatsapp|twitterbot|slackbot|linkedinbot|telegrambot|discordbot|bot\b|crawler|spider|preview/i;
const isPreviewFetch = (ua: string | undefined): boolean => !!ua && PREVIEW_CRAWLERS.test(ua);

function detectDeviceKind(userAgent: string | undefined): DeviceKind {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobile|iphone|android/.test(ua)) return 'mobile';
  if (/mozilla|windows|macintosh|linux|x11/.test(ua)) return 'desktop';
  return 'unknown';
}

/** Returns a confident 2-letter locale, or null. Never throws on malformed input. */
function parseLocale(acceptLanguage: string | undefined): string | null {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(',')[0]?.trim();
  if (!first) return null;
  const match = first.match(/^([a-zA-Z]{2})(?:[-_][a-zA-Z]{2,})?(?:;.*)?$/);
  if (!match) return null;
  return match[1].toLowerCase();
}

function getHeader(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? undefined;
  }
  return undefined;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const rawCode = event.pathParameters?.code;
    if (!rawCode) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_code' }) };
    }
    const code = normalizeCode(rawCode);
    if (!isValidJobCode(code)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_code' }) };
    }

    const rawShareParam = event.queryStringParameters?.r;
    let requestedShareCode: string | null = null;
    if (rawShareParam) {
      const normalizedShare = normalizeCode(rawShareParam);
      if (isValidShareCode(normalizedShare)) {
        requestedShareCode = normalizedShare;
      }
    }

    const pool = await getPublicJobsDbPool();
    client = await pool.connect();

    // RLS's jobs_public_read policy (public_listing_enabled) already makes an
    // opted-out job invisible here -- it lands in the same zero-row branch as
    // a code that never existed, which is exactly the point: both are 404,
    // identically.
    const jobResult = await client.query(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE public_code = $1`,
      [code],
    );

    if (jobResult.rows.length === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const job = jobResult.rows[0];

    // Recording the open must never fail the request.
    try {
      const userAgent = getHeader(event, 'User-Agent');

      // A preview crawler still gets the job (so link previews render), but
      // does not count as an open.
      if (!isPreviewFetch(userAgent)) {
        let matchedShareCode: string | null = null;
        if (requestedShareCode) {
          const shareResult = await client.query(
            `SELECT code FROM job_share_links WHERE code = $1 AND job_id = $2`,
            [requestedShareCode, job.id],
          );
          if (shareResult.rows.length > 0) {
            matchedShareCode = requestedShareCode;
          }
        }

        const acceptLanguage = getHeader(event, 'Accept-Language');
        const ip = event.requestContext?.identity?.sourceIp ?? undefined;

        const deviceKind = detectDeviceKind(userAgent);
        const locale = parseLocale(acceptLanguage);

        let visitorHash: string | null = null;
        // From Secrets Manager, TTL-cached — never an env var, which would put
        // the one value protecting IP+UA from brute-force into the CFN template.
        const salt = await getVisitorSalt();
        if (salt && ip && userAgent) {
          visitorHash = hashVisitor(salt, ip, userAgent);
        }

        // The insert and the counter bump must land together: open_count is
        // surfaced directly to the referring worker (GET /worker/referrals), so
        // a partial write here would silently under-report opens with nothing
        // in the data to reveal the drift.
        await client.query('BEGIN');
        try {
          // Guarded insert: the same visitor re-opening within the window is a
          // no-op, so a refresh or a link bouncing around one person's devices
          // does not inflate the count. A null visitor_hash cannot be
          // de-duplicated (no salt configured) and always records —
          // under-counting a real visit is worse than a duplicate. Backed by
          // job_share_opens_visitor_dedupe_idx (migration 057).
          const inserted = await client.query(
            `INSERT INTO job_share_opens (share_code, job_id, device_kind, locale, visitor_hash)
             SELECT $1, $2, $3, $4, $5
              WHERE $5::text IS NULL
                 OR NOT EXISTS (
                   SELECT 1 FROM job_share_opens
                    WHERE visitor_hash = $5
                      AND job_id = $2
                      AND opened_at > now() - interval '30 minutes'
                 )
             RETURNING id`,
            [matchedShareCode, job.id, deviceKind, locale, visitorHash],
          );

          if (inserted.rows.length > 0 && matchedShareCode) {
            // Column-scoped GRANT only permits open_count and last_opened_at.
            await client.query(
              `UPDATE job_share_links
                  SET open_count = open_count + 1,
                      last_opened_at = now()
                WHERE code = $1`,
              [matchedShareCode],
            );
          }

          await client.query('COMMIT');
        } catch (openErr) {
          await client.query('ROLLBACK');
          throw openErr;
        }
      }
    } catch (openErr) {
      console.error('public-job open-record error:', errorMessage(openErr));
    }

    if (job.status !== 'active') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          code: job.code,
          title: job.title,
          company: job.company,
          location: job.location,
          status: 'closed',
          applications_closed: true,
        }),
      };
    }

    const { id: _internalId, ...publicJob } = job;
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(publicJob),
    };
  } catch (err) {
    console.error('public-job error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
