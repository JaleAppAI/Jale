import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeCode, isValidShareCode } from '../lib/referral-codes';
import { writeWebAttribution } from '../lib/referral-attribution';

const CORS_HEADERS = corsHeaders();

/**
 * POST /worker/referrals/claim
 *
 * Called once, right after a worker finishes signup on the web referral-apply
 * path, with the `shareCode` carried in the browser from the public job page
 * URL (`/j/{code}?r={shareCode}`). Mirrors worker-job-share.ts for auth, RLS
 * context, and the worker-only check -- but deliberately NOT the compliance
 * gate (see the inline note below).
 *
 * An unknown or revoked share code is NOT an error -- `{ claimed: false }`
 * with a 200 status, identically to a valid-shaped code that simply doesn't
 * resolve. This endpoint must never become an oracle for probing which codes
 * exist: a 404/400 that only fires for real codes would let anyone enumerate
 * valid share codes by trying random 8-character strings.
 *
 * Never logs the share code, any free text, or a phone value -- only static
 * error codes and ids cross into any log line here.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: { shareCode?: unknown };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { shareCode: rawShareCode } = body;
    if (typeof rawShareCode !== 'string') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_share_code' }) };
    }
    const shareCode = normalizeCode(rawShareCode);
    if (!isValidShareCode(shareCode)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_share_code' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    // DELIBERATELY NO checkCompliance/ToS gate here, unlike the sibling worker
    // endpoints. This endpoint fires seconds after OTP verification, BEFORE the
    // user has ever been shown the legal wall (post-confirmation creates the
    // users row with no tos_version, and acceptance happens later on the first
    // protected page) -- a compliance gate would 403 every brand-new signup,
    // silently losing the referral it exists to record. Recording where an
    // account came from is internal bookkeeping about the signup itself, not a
    // legal-gated user action: it grants nothing, reveals nothing, and writes
    // only the caller's own attribution row.
    const workerRes = await client.query(`SELECT id, user_type FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (workerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (workerRes.rows[0].user_type !== 'worker') {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'worker_only' }) };
    }
    const workerId: string = workerRes.rows[0].id;

    const { written } = await writeWebAttribution(client, workerId, shareCode, new Date());

    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ claimed: written }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-referral-claim error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
