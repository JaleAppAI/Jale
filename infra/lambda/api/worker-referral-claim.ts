import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeCode, isValidShareCode } from '../lib/referral-codes';
import { writeWebAttribution } from '../lib/referral-attribution';
import { recordReferredJob } from '../lib/referred-jobs';
import { isUuid } from '../lib/uuid';

const CORS_HEADERS = corsHeaders();

/**
 * POST /worker/referrals/claim  `{ jobId?, shareCode? }`
 *
 * Called right after a worker signs up or signs in on the web with a job in
 * the URL, and when a signed-in worker opens a job link. Each field is
 * validated on its own, and an unusable one is simply ignored:
 *  - a `jobId` (a UUID) puts that job on the worker's referred-jobs list
 *    (`job_page`);
 *  - a `shareCode` (`/j/{code}?r={shareCode}`) earns first-touch referral
 *    credit exactly as before, then puts the link's job on the list
 *    (`share_link`). It runs after the jobId record, so a job that came both
 *    ways ends as `share_link`. The list is not the credit: a worker who was
 *    credited long ago still gets the job listed.
 * A body with neither usable is a 400 `invalid_request`. Mirrors
 * worker-job-share.ts for auth, RLS context, and the worker-only check -- but
 * deliberately NOT the compliance gate (see the inline note below).
 *
 * An unknown, inactive or revoked job or code is NOT an error -- a 200 with
 * `claimed: false` and nothing in `recorded`, identically to a valid-shaped
 * value that simply doesn't resolve. This endpoint must never become an
 * oracle for probing which codes or jobs exist: a 404/400 that only fires for
 * real ones would let anyone enumerate valid share codes by trying random
 * 8-character strings.
 *
 * Never logs the share code, a job id, any free text, or a phone value --
 * only static error codes cross into any log line here.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }
    // `null`, an array or a bare value parses fine but is not a request.
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { jobId: rawJobId, shareCode: rawShareCode } = body as { jobId?: unknown; shareCode?: unknown };
    // Lower-cased so that a job named by both fields is listed once: the
    // link's job_id comes back from the database in canonical form.
    const jobId = typeof rawJobId === 'string' && isUuid(rawJobId) ? rawJobId.toLowerCase() : null;
    const normalizedCode = typeof rawShareCode === 'string' ? normalizeCode(rawShareCode) : null;
    const shareCode = normalizedCode !== null && isValidShareCode(normalizedCode) ? normalizedCode : null;
    if (jobId === null && shareCode === null) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_request' }) };
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
    // only the caller's own attribution and referred-jobs rows.
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

    // A job is recorded only while it is active; `recorded` lists the ones
    // that were, each once.
    const recorded = new Set<string>();
    if (jobId !== null && (await recordReferredJob(client, { workerId, jobId, source: 'job_page' }))) {
      recorded.add(jobId);
    }

    let claimed = false;
    if (shareCode !== null) {
      ({ written: claimed } = await writeWebAttribution(client, workerId, shareCode, new Date()));
      // The same capability resolution writeWebAttribution uses: the one
      // active link for the code, or no row.
      const linkRes = await client.query<{ job_id: string }>(
        `SELECT job_id FROM jale_cap.resolve_share_link($1)`,
        [shareCode],
      );
      const linkJobId = linkRes.rows[0]?.job_id;
      if (linkJobId && (await recordReferredJob(client, { workerId, jobId: linkJobId, source: 'share_link' }))) {
        recorded.add(linkJobId);
      }
    }

    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ claimed, recorded: [...recorded] }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-referral-claim error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
