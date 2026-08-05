import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage, requireAbsoluteBaseUrl } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { generateShareCode } from '../lib/referral-codes';

const CORS_HEADERS = corsHeaders();

// Client-selectable channels only. 'unknown' exists in the DB CHECK constraint
// (migration 056) so an untagged arrival can still be recorded, but it is a
// server-assigned value for opens with a stripped/invalid tag -- an employer
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

    // The frontend sends { channel: 'copy_link' } explicitly, but an omitted
    // channel defaults to 'copy_link' rather than rejecting the request -- an
    // explicit invalid value (including a bare null) is still a 400.
    const channel = body.channel === undefined ? 'copy_link' : body.channel;
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
      console.error('employer-job-share error: share_url_misconfigured');
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

    const employerRes = await client.query(`SELECT id, user_type FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (employerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    // Explicit choice: this endpoint mints rows keyed by referrer_employer_id,
    // and referral reporting built on job_share_links assumes a referrer of
    // the kind the endpoint declares. A worker authenticating here is not an
    // intended "worker posting as employer" feature -- reject it rather than
    // silently accepting a worker as an employer referrer.
    if (employerRes.rows[0].user_type !== 'employer') {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'employer_only' }) };
    }
    const employerId: string = employerRes.rows[0].id;

    // Single combined predicate so a job the caller does not own, a
    // paused/filled/closed job, and a job with public_listing_enabled = false
    // all return the same generic 404 -- we must not leak which condition
    // failed.
    const jobRes = await client.query(
      `SELECT j.id, j.public_code FROM jobs j
         JOIN users u ON u.id = j.employer_id
        WHERE j.id = $1
          AND u.cognito_sub = $2
          AND j.status = 'active'
          AND j.public_listing_enabled = true`,
      [jobId, cognitoSub],
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
        // partial (WHERE referrer_employer_id IS NOT NULL), so a bare
        // ON CONFLICT (job_id, referrer_employer_id, channel) would not match it.
        const insertRes = await client.query(
          `INSERT INTO job_share_links (code, job_id, referrer_employer_id, channel)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id, referrer_employer_id, channel) WHERE referrer_employer_id IS NOT NULL
           DO UPDATE SET updated_at = now()
           RETURNING code`,
          [candidate, jobId, employerId, channel],
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
    console.error('employer-job-share error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
