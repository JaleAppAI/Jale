import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPublicJobsDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import {
  normalizeCode,
  isValidJobCode,
  isValidShareCode,
  generateApplyToken,
  hashToken,
  formatApplyToken,
} from '../lib/referral-codes';

/**
 * POST /public/jobs/{code}/apply-intent
 *
 * Mints the token that carries the referral from the public web page into
 * WhatsApp. Unauthenticated, same restricted role and connection approach as
 * public-job.ts. NEVER calls setRlsContext.
 */

const CORS_HEADERS = corsHeaders();
const UNIQUE_VIOLATION = '23505';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getHeader(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? undefined;
  }
  return undefined;
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

    // Same 404-for-both-unknown-and-opted-out behavior as public-job.ts: the
    // jobs_public_read RLS policy already hides opted-out jobs.
    const jobResult = await client.query(
      `SELECT id, status FROM jobs WHERE public_code = $1`,
      [code],
    );

    if (jobResult.rows.length === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const job = jobResult.rows[0];
    if (job.status !== 'active') {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_active' }) };
    }

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

    const locale = parseLocale(getHeader(event, 'Accept-Language'));
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    let rawToken: string | undefined;
    // Generator is pure; uniqueness is the index's job. Retry once on collision.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = generateApplyToken();
      const tokenHash = hashToken(candidate);
      try {
        await client.query(
          `INSERT INTO referral_apply_tokens (token_hash, share_code, job_id, locale, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [tokenHash, matchedShareCode, job.id, locale, expiresAt],
        );
        rawToken = candidate;
        break;
      } catch (insertErr) {
        const pgErrorCode = (insertErr as { code?: string })?.code;
        if (pgErrorCode === UNIQUE_VIOLATION && attempt === 0) {
          continue;
        }
        throw insertErr;
      }
    }

    if (!rawToken) {
      // Should be unreachable: the loop above either sets rawToken or throws.
      console.error('public-job-apply-intent error: token mint exhausted retries');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
    }

    const formattedToken = formatApplyToken(rawToken);
    const message = `I want to apply for this job: ${formattedToken}`;
    const whatsappUrl = `https://wa.me/${process.env.WHATSAPP_BUSINESS_NUMBER}?text=${encodeURIComponent(message)}`;

    // The raw token is returned to the caller exactly once and is never logged.
    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({ token: formattedToken, whatsappUrl }),
    };
  } catch (err) {
    console.error('public-job-apply-intent error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
