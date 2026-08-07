import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPublicJobsDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeCode, isValidJobCode, isValidShareCode } from '../lib/referral-codes';

/**
 * GET /public/jobs/{code}/referrer?r=
 *
 * Unauthenticated. Connects as jale_public_jobs (see lib/db.ts getPublicJobsDbPool).
 * NEVER calls setRlsContext -- there is no Cognito sub on this route.
 *
 * Tells the public job page who referred this visitor (e.g. "Maria shared
 * this job with you") so it can render the referrer's first name and kind.
 * A share code that is malformed, revoked, organic (no code at all), or that
 * points at the wrong job is indistinguishable from an unknown one -- all of
 * them are 404 not_found, so this endpoint cannot be used to enumerate valid
 * share codes.
 */

const CORS_HEADERS = corsHeaders();

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
    if (!rawShareParam) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }
    const shareCode = normalizeCode(rawShareParam);
    // A bad share code is indistinguishable from an unknown one -- both 404.
    if (!isValidShareCode(shareCode)) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const pool = await getPublicJobsDbPool();
    client = await pool.connect();

    // Zero rows covers unknown, revoked, organic (no code), and wrong-job
    // share codes alike -- public_referrer_context() collapses them all.
    const result = await client.query(
      `SELECT kind, first_name FROM public_referrer_context($1, $2)`,
      [shareCode, code],
    );

    if (result.rows.length === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const { kind, first_name: firstName } = result.rows[0];
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ kind, first_name: firstName }),
    };
  } catch (err) {
    console.error('public-job-referrer error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
