import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage, requireAbsoluteBaseUrl } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { generateShareCode } from '../lib/referral-codes';

const CORS_HEADERS = corsHeaders();

// Client-selectable channels only. 'unknown' exists in the DB CHECK constraint
// (migration 056) so an untagged arrival can still be recorded, but it is a
// server-assigned value for opens with a stripped/invalid tag -- a worker
// minting a share link always knows which button they pressed, so accepting
// 'unknown' here would let a client masquerade an untagged link as tagged.
const ALLOWED_CHANNELS = ['whatsapp', 'sms', 'facebook', 'copy_link', 'device_share'] as const;
type Channel = (typeof ALLOWED_CHANNELS)[number];

function isAllowedChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (ALLOWED_CHANNELS as readonly string[]).includes(value);
}

const MAX_CODE_ATTEMPTS = 5;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_job_id' }) };
    }

    let body: { channel?: unknown };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { channel } = body;
    if (!isAllowedChannel(channel)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_channel' }) };
    }

    // Fail fast, before ever touching the DB, if the base URL a share link
    // must be built from is missing or malformed. Minting a row and handing
    // back a relative path is worse than refusing the request outright --
    // the URL's entire purpose is to be pasted somewhere with no origin of
    // its own (WhatsApp, SMS), where a relative link is simply dead.
    const base = requireAbsoluteBaseUrl(process.env.PUBLIC_SITE_BASE_URL);
    if (!base) {
      console.error('worker-job-share error: share_url_misconfigured');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'share_url_misconfigured' }) };
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
    // Explicit choice: this endpoint mints rows keyed by referrer_worker_id,
    // and referral reporting (worker-referrals.ts, worker_attribution) is
    // built on the assumption that a referrer is a worker. An employer
    // authenticating here is not an intended "employer self-share" feature --
    // reject it rather than silently accepting an employer as a referrer.
    if (workerRes.rows[0].user_type !== 'worker') {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'worker_only' }) };
    }
    const workerId: string = workerRes.rows[0].id;

    // Single combined predicate so a paused/filled/closed job and a job with
    // public_listing_enabled = false return the same generic 404 -- we must
    // not leak which condition failed.
    const jobRes = await client.query(
      `SELECT id, public_code FROM jobs
        WHERE id = $1
          AND status = 'active'
          AND public_listing_enabled = true`,
      [jobId],
    );
    if (jobRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_found' }) };
    }
    const publicCode: string = jobRes.rows[0].public_code;

    // The code generator is pure (no uniqueness check); the unique index on
    // job_share_links.code owns uniqueness. Each attempt runs inside its own
    // SAVEPOINT because a unique_violation aborts the enclosing transaction
    // block in Postgres -- without the savepoint, retrying would fail every
    // subsequent statement with "current transaction is aborted".
    let code: string | undefined;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const candidate = generateShareCode();
      await client.query('SAVEPOINT share_code_attempt');
      try {
        // The WHERE clause on the arbiter is required: the unique index is
        // partial (WHERE referrer_worker_id IS NOT NULL), so a bare
        // ON CONFLICT (job_id, referrer_worker_id, channel) would not match it.
        const insertRes = await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_worker_id, channel)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id, referrer_worker_id, channel) WHERE referrer_worker_id IS NOT NULL
           DO UPDATE SET updated_at = now()
           RETURNING code`,
          [candidate, jobId, workerId, channel],
        );
        await client.query('RELEASE SAVEPOINT share_code_attempt');
        code = insertRes.rows[0].code;
        break;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT share_code_attempt');
        const isUniqueViolation = (err as { code?: string })?.code === '23505';
        if (!isUniqueViolation || attempt === MAX_CODE_ATTEMPTS - 1) {
          throw err;
        }
      }
    }

    if (!code) {
      await client.query('ROLLBACK');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
    }

    await client.query('COMMIT');

    const shareUrl = `${base}/j/${publicCode}?r=${code}`;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ code, channel, share_url: shareUrl }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-job-share error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
