import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { resolveEntitlements } from '../lib/entitlements';
import { corsHeaders, errorMessage } from '../lib/http';
import { formatPayRange, JOB_TYPES, parseJobFields, parseOptionalCoordinates, parseRequiredDocs } from '../lib/job-fields';
import { setJobCoordinates } from '../lib/location';
import { parseCityFields, parseCityFromLocation } from '../lib/city-fields';
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
      pay_interval?: string | null;
      start_date?: string | null;
      expected_duration?: string | null;
      shift_schedule?: string | null;
      transportation_required?: boolean;
      work_authorization_required?: boolean;
      language_preference?: string[];
      number_of_workers_needed?: number;
      trade_category?: string;
      required_experience_years?: number | null;
      required_experience_months?: number | null;
      certifications?: string[];
      city_key?: string;
      city?: string;
      state?: string;
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

    const coordinates = parseOptionalCoordinates(body as Record<string, unknown>);
    if (!coordinates.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: coordinates.error }) };
    }

    const cityFields = parseCityFields(body as Record<string, unknown>);
    if (!cityFields.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: cityFields.error }) };
    }

    // Degraded-picker fallback: no triple sent -> best-effort parse of the
    // free-text location, so the job still enters city-filtered feeds.
    const cityTriple = cityFields.value ?? parseCityFromLocation(location);

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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    // A7: Lock the employer's users row to serialize concurrent slot consumers.
    // SELECT … FOR UPDATE on users ensures two simultaneous creates for the same
    // employer cannot both read "0 active jobs" and both insert.
    const lockResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE`,
      [cognitoSub],
    );
    const userId = lockResult.rows[0]?.id;

    // Resolve entitlements AFTER acquiring the lock so the limit is authoritative.
    const entitlements = await resolveEntitlements(client, userId);

    // Count the employer's current active jobs while holding the lock.
    const countResult = await client.query<{ active_jobs: number }>(
      `SELECT COUNT(*)::int AS active_jobs FROM jobs WHERE employer_id = $1 AND status = 'active'`,
      [userId],
    );
    const activeJobs = countResult.rows[0].active_jobs;

    if (activeJobs >= entitlements.activeJobLimit) {
      await client.query('ROLLBACK');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'job_limit_reached',
          plan_code: entitlements.planCode,
          active_job_limit: entitlements.activeJobLimit,
          active_jobs: activeJobs,
        }),
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
         pay_interval,
         start_date,
         expected_duration,
         shift_schedule,
         transportation_required,
         work_authorization_required,
         language_preference,
         number_of_workers_needed,
         trade_category,
         required_experience_years,
         required_experience_months,
         certifications,
         city_key,
         city,
         state
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
       )
       RETURNING id, title, location, pay, job_type, status, required_docs, created_at,
         pay_min, pay_max, pay_interval, start_date, expected_duration, shift_schedule,
         transportation_required, work_authorization_required, language_preference, number_of_workers_needed,
         workers_hired AS hired_count,
         GREATEST(number_of_workers_needed - workers_hired, 0) AS open_count,
         trade_category, required_experience_years, required_experience_months, certifications,
         city_key, city, state`,
      [
        userId,
        title.trim(),
        location.trim(),
        formatPayRange(jobFields.value.pay_min, jobFields.value.pay_max),
        job_type,
        description ?? null,
        required_docs,
        jobFields.value.pay_min,
        jobFields.value.pay_max,
        jobFields.value.pay_interval,
        jobFields.value.start_date,
        jobFields.value.expected_duration,
        jobFields.value.shift_schedule,
        jobFields.value.transportation_required,
        jobFields.value.work_authorization_required,
        jobFields.value.language_preference,
        jobFields.value.number_of_workers_needed,
        jobFields.value.trade_category,
        jobFields.value.required_experience_years,
        jobFields.value.required_experience_months,
        jobFields.value.certifications,
        cityTriple?.city_key ?? null,
        cityTriple?.city ?? null,
        cityTriple?.state ?? null,
      ],
    );
    const job = result.rows[0];

    if (coordinates.value) {
      await setJobCoordinates(client, job.id, coordinates.value.latitude, coordinates.value.longitude, 'manual');
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
