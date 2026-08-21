import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { verifyUnsubscribeToken } from '../lib/unsubscribe-token';

/**
 * POST /public/employer-digest/unsubscribe   (UNAUTHENTICATED)
 *
 * One-click unsubscribe from the employer daily digest. There is no Cognito
 * authorizer on this route on purpose: the recipient of a digest email is
 * clicking a link, not holding a session, so the HMAC-signed token IS the
 * credential. lib/unsubscribe-token.ts verifies it BEFORE anything touches the
 * database — migration 080's `unsubscribe_employer` header says explicitly
 * that the function does not authenticate its caller and that
 * `p_token_version` must not be treated as an authenticator.
 *
 * Every rejection returns the identical `{"error":"invalid_token"}` 400.
 * Malformed JSON, a missing field, a bad signature, a non-UUID employer id and
 * an out-of-range version are indistinguishable to the caller: the endpoint is
 * public and must not become an oracle for which halves of a guessed token are
 * right.
 *
 * A genuine token whose version no longer matches the row is NOT an error. The
 * function returns false, and this endpoint still answers 200
 * `{"status":"unsubscribed"}` — the requested end state (not receiving the
 * digest) already holds, and an error would only invite the recipient to click
 * again. That also makes a double-click, an email-client prefetch, and a retry
 * all safely idempotent.
 *
 * Runs as jale_admin, which holds EXECUTE on the definer function and nothing
 * else it needs here. No RLS GUC is set: the function is SECURITY DEFINER and
 * is documented as callable with no `app.*` setting, and there is no employer
 * session to impersonate on an unauthenticated route.
 */

const CORS_HEADERS = corsHeaders();

/** Uniform rejection — see the header for why the reason is never disclosed. */
const INVALID_TOKEN: APIGatewayProxyResult = {
  statusCode: 400,
  headers: CORS_HEADERS,
  body: JSON.stringify({ error: 'invalid_token' }),
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
    } catch {
      return INVALID_TOKEN;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return INVALID_TOKEN;

    const token = body.token;
    if (typeof token !== 'string' || token.length === 0) return INVALID_TOKEN;

    // A throw from here (unreadable signing secret) must NOT become a 400 —
    // that would blame the caller for a service fault. It falls through to the
    // 500 below.
    const claims = await verifyUnsubscribeToken(token);
    if (!claims) return INVALID_TOKEN;

    const pool = await getDbPool();
    client = await pool.connect();

    // Single autocommit statement; the flip lives entirely inside the definer
    // function, which is the only thing granted UPDATE (enabled) on the table.
    await client.query<{ unsubscribed: boolean }>(
      'SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS unsubscribed',
      [claims.employerId, claims.version],
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: 'unsubscribed' }),
    };
  } catch (err) {
    console.error('digest-unsubscribe error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
