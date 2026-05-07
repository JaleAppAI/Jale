import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
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

    const workerId = event.pathParameters?.worker_id;
    const jobId = event.queryStringParameters?.job_id;
    if (!workerId || !jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'missing_params',
          required: ['worker_id', 'job_id'],
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

    // Verify employer owns the job
    const jobCheck = await client.query(
      `SELECT id FROM jobs WHERE id = $1 AND employer_id = (SELECT id FROM users WHERE cognito_sub = $2)`,
      [jobId, cognitoSub],
    );
    if (jobCheck.rows.length === 0) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'forbidden' }),
      };
    }

    const result = await client.query(
      `SELECT wp.user_id AS worker_id, u.full_name, u.phone,
              ARRAY(
                SELECT ws.skill
                FROM worker_skills ws
                WHERE ws.worker_id = wp.user_id
                ORDER BY ws.skill
              ) AS skills,
              wp.availability,
              wp.years_experience, wp.location, ja.status AS application_status, ja.applied_at
       FROM job_applications ja
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ja.job_id = $1 AND ja.worker_id = $2`,
      [jobId, workerId],
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'not_found' }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('employer-worker-profile error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
