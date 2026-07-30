import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

/**
 * PATCH /employer/jobs/{jobId}/public-listing
 *
 * The single write path for jobs.public_listing_enabled — the employer's
 * opt-IN to a public job page (migration 056; default false, nobody is public
 * until they choose to be).
 *
 * Deliberately its own endpoint rather than a new entry in
 * employer-jobs-update.ts's EDITABLE_COLUMNS: that array drives a
 * full-replacement SET clause, so any edit omitting the field would write NULL
 * (violating NOT NULL) or silently flip a deliberate employer choice back.
 * Mirrors the targeted, ownership-scoped status branch of that handler instead.
 */

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_job_id' }) };
    }
    if (!UUID_REGEX.test(jobId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_id' }) };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { enabled } = body;
    // Strict boolean: publishing a job to the open internet is a consent
    // action, so "true", 1 and other truthy shapes are rejected rather than
    // coerced.
    if (typeof enabled !== 'boolean') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_enabled' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    const result = await client.query(
      `WITH employer_job AS (
         SELECT j.id FROM jobs j
           JOIN users u ON u.id = j.employer_id
          WHERE j.id = $2 AND u.cognito_sub = $3
       )
       UPDATE jobs SET public_listing_enabled = $1
         FROM employer_job
        WHERE jobs.id = employer_job.id
       RETURNING jobs.id, jobs.public_code, jobs.public_listing_enabled`,
      [enabled, jobId, cognitoSub],
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      // Not-found and not-yours are the same response: never confirm a job
      // exists to someone who does not own it.
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_found' }) };
    }

    await client.query('COMMIT');

    const row = result.rows[0];
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        id: row.id,
        public_code: row.public_code,
        public_listing_enabled: row.public_listing_enabled,
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('employer-job-public-listing error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
