import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { setJobCoordinates } from '../lib/location';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: {
      title?: string;
      location?: string;
      job_type?: string;
      description?: string;
      required_docs?: string[];
      latitude?: number;
      longitude?: number;
    };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { title, location, job_type, description } = body;
    if (!title?.trim() || !location?.trim() || !job_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields', required: ['title', 'location', 'job_type'] }) };
    }

    const validTypes = ['full-time', 'part-time', 'contract'];
    if (!validTypes.includes(job_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_type', valid: validTypes }) };
    }

    const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'];
    const required_docs = body.required_docs ?? [];
    if (
      !Array.isArray(required_docs) ||
      required_docs.some((d) => !VALID_DOC_TYPES.includes(d))
    ) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_required_docs', valid: VALID_DOC_TYPES }),
      };
    }

    const hasLatitude = Object.prototype.hasOwnProperty.call(body, 'latitude');
    const hasLongitude = Object.prototype.hasOwnProperty.call(body, 'longitude');
    if (hasLatitude !== hasLongitude) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_coordinates' }) };
    }
    if (hasLatitude) {
      if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_latitude' }) };
      }
      if (typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_longitude' }) };
      }
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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    const result = await client.query(
      `INSERT INTO jobs (employer_id, title, location, job_type, description, required_docs)
       VALUES (
         (SELECT id FROM users WHERE cognito_sub = $1),
         $2, $3, $4, $5, $6
       )
       RETURNING id, title, location, job_type, status, required_docs, created_at`,
      [cognitoSub, title.trim(), location.trim(), job_type, description ?? null, required_docs],
    );
    const job = result.rows[0];

    if (hasLatitude) {
      await setJobCoordinates(client, job.id, body.latitude!, body.longitude!, 'manual');
    }

    await client.query('COMMIT');

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...job, applicant_count: 0 }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-create error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
