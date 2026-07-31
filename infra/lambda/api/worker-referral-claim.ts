import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { normalizeCode, isValidShareCode } from '../lib/referral-codes';
import { writeWebAttribution } from '../lib/referral-attribution';

const CORS_HEADERS = corsHeaders();

/**
 * POST /worker/referrals/claim
 *
 * Called once, right after a worker finishes signup on the web referral-apply
 * path, with the `shareCode` carried in the browser from the public job page
 * URL (`/j/{code}?r={shareCode}`). Mirrors worker-job-share.ts for auth, the
 * compliance gate, RLS context, and the worker-only check.
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

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

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
