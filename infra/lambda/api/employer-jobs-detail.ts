import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

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
      `SELECT id, title, location, city, state_region, pay, job_type, status, description,
         required_docs, optional_docs, required_fields, optional_fields, created_at,
         pay_min, pay_max, pay_interval, start_date, expected_duration, shift_schedule,
         transportation_required, work_authorization_required, language_preference, number_of_workers_needed,
         workers_hired AS hired_count,
         GREATEST(number_of_workers_needed - workers_hired, 0) AS open_count,
         trade_category, required_experience_years, required_experience_months, certifications,
         trade_category_other, expected_duration_bucket, work_days, shift_start, shift_end, certification_requirements,
         public_code, public_listing_enabled,
         city_key, city, state, latitude::float8 AS latitude, longitude::float8 AS longitude,
         (SELECT COUNT(*)::int FROM job_applications WHERE job_id = $1) AS applicant_count
       FROM jobs
       WHERE id = $1
         AND employer_id = (SELECT id FROM users WHERE cognito_sub = $2)`,
      [jobId, cognitoSub],
    );

    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_found' }) };
    }

    const job = result.rows[0];
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ...job,
        // All four requirement arrays must round-trip to EditJobModal: the
        // edit payload always re-sends them (no omit path in the frontend
        // mappers), so omitting any array here would wipe it on the next save
        // — or permanently 409-lock a job whose requirements are frozen.
        required_docs: Array.isArray(job.required_docs) ? job.required_docs : [],
        optional_docs: Array.isArray(job.optional_docs) ? job.optional_docs : [],
        required_fields: Array.isArray(job.required_fields) ? job.required_fields : [],
        optional_fields: Array.isArray(job.optional_fields) ? job.optional_fields : [],
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-detail error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
