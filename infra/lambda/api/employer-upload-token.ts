import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash, randomBytes } from 'crypto';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized' }),
      };
    }

    let body: { job_id?: string; worker_id?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json' }),
      };
    }

    const { job_id, worker_id } = body;
    if (!job_id || !worker_id) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'missing_fields',
          required: ['job_id', 'worker_id'],
        }),
      };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(
      client,
      cognitoSub,
      process.env.REQUIRED_TOS_VERSION!,
    );
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'user_not_provisioned' }),
      };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
        }),
      };
    }

    const applicantCheck = await client.query<{ worker_id: string; job_id: string; employer_user_id: string }>(
      `SELECT ja.worker_id, ja.job_id, employer.id AS employer_user_id
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users employer ON employer.id = j.employer_id
       WHERE ja.job_id = $1
         AND ja.worker_id = $2
         AND employer.cognito_sub = $3`,
      [job_id, worker_id, cognitoSub],
    );
    if (applicantCheck.rows.length === 0) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'forbidden' }),
      };
    }

    // The capability function reads the caller from the internal id, the
    // employer's users.id proven by the join above.
    await setInternalUserRlsContext(client, applicantCheck.rows[0].employer_user_id);
    await setAuditContext(
      client,
      auditCaller(event, { kind: 'employer', id: applicantCheck.rows[0].employer_user_id }, 'web'),
      'employer.upload_link',
    );

    // Only the hash reaches the database; the function re-checks ownership
    // and the application, and sets the 7-day expiry itself.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const issued = await client.query<{ outcome: string }>(
      `SELECT outcome, expires_at FROM jale_cap.upload_token_issue($1, $2, $3)`,
      [tokenHash, job_id, worker_id],
    );
    const outcome = issued.rows[0]?.outcome;
    if (outcome === 'forbidden') {
      await client.query('ROLLBACK');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'forbidden' }),
      };
    }
    if (outcome !== 'ok') {
      throw new Error(`upload_token_issue_unexpected_outcome:${String(outcome)}`);
    }

    await client.query('COMMIT');

    const uploadUrl = `${process.env.FRONTEND_BASE_URL}/en/upload/${rawToken}`;
    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({ upload_url: uploadUrl }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('employer-upload-token error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
