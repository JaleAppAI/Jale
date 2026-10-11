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
 * database — migration 082's `unsubscribe_employer` header says explicitly
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
 *
 * -- TWO CALLERS, ONE ROUTE ---------------------------------------
 *
 * 1. The browser form at /[locale]/digest-unsubscribe. `Content-Type:
 *    application/json`, `{"token":"..."}`, JSON answers. Unchanged.
 *
 * 2. RFC 8058 one-click. A MAIL PROVIDER (Gmail, Yahoo, Apple Mail) POSTs
 *    `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded` to
 *    the URL in the message's `List-Unsubscribe` header, with the token in the
 *    QUERY STRING -- the RFC reserves the body for that one fixed field, so
 *    there is nowhere else to put it. There is no human at the other end, so
 *    the answer is a bare status with an EMPTY text/plain body: RFC 8058
 *    forbids a redirect, and a JSON envelope nobody parses is just bytes.
 *
 * The two are told apart by Content-Type rather than by a second route: a
 * second API Gateway method would have to be threaded through ApiStack's
 * centralized MethodSettings throttle array, and both callers want exactly the
 * same definer call underneath.
 */

const CORS_HEADERS = corsHeaders();
const ONE_CLICK_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' };
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** Uniform rejection — see the header for why the reason is never disclosed. */
const INVALID_TOKEN: APIGatewayProxyResult = {
  statusCode: 400,
  headers: CORS_HEADERS,
  body: JSON.stringify({ error: 'invalid_token' }),
};

/** Same 400, no body: the one-click caller is a mail server, not a page. */
const ONE_CLICK_INVALID: APIGatewayProxyResult = {
  statusCode: 400,
  headers: ONE_CLICK_HEADERS,
  body: '',
};

/** API Gateway lowercases nothing for us, and RFC 9110 header names are case-insensitive. */
function headerValue(event: APIGatewayProxyEvent, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return '';
}

function decodedBody(event: APIGatewayProxyEvent): string {
  const raw = event.body ?? '';
  return event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  // Content-Type may legitimately carry parameters (`; charset=UTF-8`), so
  // match the media-type prefix rather than the whole value.
  const oneClick = headerValue(event, 'content-type').trim().toLowerCase().startsWith(FORM_CONTENT_TYPE);

  try {
    let token: unknown;

    if (oneClick) {
      // The body must be exactly the RFC's fixed field. Anything else is not a
      // one-click unsubscribe, and treating it as one would turn the route
      // into a token-spender for any form post that happens to arrive.
      const form = new URLSearchParams(decodedBody(event));
      if (form.get('List-Unsubscribe') !== 'One-Click') return ONE_CLICK_INVALID;
      token = event.queryStringParameters?.token;
      if (typeof token !== 'string' || token.length === 0) return ONE_CLICK_INVALID;
    } else {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(event.body ?? '{}') as Record<string, unknown>;
      } catch {
        return INVALID_TOKEN;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return INVALID_TOKEN;

      token = body.token;
      if (typeof token !== 'string' || token.length === 0) return INVALID_TOKEN;
    }

    // A throw from here (unreadable signing secret) must NOT become a 400 —
    // that would blame the caller for a service fault. It falls through to the
    // 500 below.
    const claims = await verifyUnsubscribeToken(token);
    if (!claims) return oneClick ? ONE_CLICK_INVALID : INVALID_TOKEN;

    const pool = await getDbPool();
    client = await pool.connect();

    // Single autocommit statement; the flip lives entirely inside the definer
    // function, which is the only thing granted UPDATE (enabled) on the table.
    await client.query<{ unsubscribed: boolean }>(
      'SELECT jale_digest_internal.unsubscribe_employer($1::uuid, $2::smallint) AS unsubscribed',
      [claims.employerId, claims.version],
    );

    // No redirect on either path. RFC 8058 forbids one for one-click, and the
    // browser form is a fetch() that reads the status, not a navigation.
    return oneClick
      ? { statusCode: 200, headers: ONE_CLICK_HEADERS, body: '' }
      : { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ status: 'unsubscribed' }) };
  } catch (err) {
    console.error('digest-unsubscribe error:', errorMessage(err));
    return oneClick
      ? { statusCode: 500, headers: ONE_CLICK_HEADERS, body: '' }
      : { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
