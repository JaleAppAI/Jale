import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { formatPayRange, JOB_TYPES, parseJobFields, parseRequiredDocs } from '../lib/job-fields';
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
      pay_min?: number | null;
      pay_max?: number | null;
      start_date?: string | null;
      expected_duration?: string | null;
      shift_schedule?: string | null;
      transportation_required?: boolean;
      language_preference?: string[];
      number_of_workers_needed?: number;
      trade_category?: string;
      required_experience_years?: number | null;
      certifications?: string[];
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

    if (!JOB_TYPES.includes(job_type as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_type', valid: JOB_TYPES }) };
    }

    const requiredDocsResult = parseRequiredDocs(body.required_docs);
    if (!requiredDocsResult.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: requiredDocsResult.error, valid: requiredDocsResult.valid }),
      };
    }
    const required_docs = requiredDocsResult.value;

    const jobFields = parseJobFields(body as Record<string, unknown>);
    if (!jobFields.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: jobFields.error, ...(jobFields.valid ? { valid: jobFields.valid } : {}) }),
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
      `INSERT INTO jobs (
         employer_id,
         title,
         location,
         pay,
         job_type,
         description,
         required_docs,
         pay_min,
         pay_max,
         start_date,
         expected_duration,
         shift_schedule,
         transportation_required,
         language_preference,
         number_of_workers_needed,
         trade_category,
         required_experience_years,
         certifications
       )
       VALUES (
         (SELECT id FROM users WHERE cognito_sub = $1),
         $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15, $16, $17, $18
       )
       RETURNING id, title, location, pay, job_type, status, required_docs, created_at,
         pay_min, pay_max, start_date, expected_duration, shift_schedule,
         transportation_required, language_preference, number_of_workers_needed,
         workers_hired AS hired_count,
         GREATEST(number_of_workers_needed - workers_hired, 0) AS open_count,
         trade_category, required_experience_years, certifications`,
      [
        cognitoSub,
        title.trim(),
        location.trim(),
        formatPayRange(jobFields.value.pay_min, jobFields.value.pay_max),
        job_type,
        description ?? null,
        required_docs,
        jobFields.value.pay_min,
        jobFields.value.pay_max,
        jobFields.value.start_date,
        jobFields.value.expected_duration,
        jobFields.value.shift_schedule,
        jobFields.value.transportation_required,
        jobFields.value.language_preference,
        jobFields.value.number_of_workers_needed,
        jobFields.value.trade_category,
        jobFields.value.required_experience_years,
        jobFields.value.certifications,
      ],
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
