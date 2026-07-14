import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { resolveEntitlements } from '../lib/entitlements';
import { corsHeaders, errorMessage } from '../lib/http';
import { WRITABLE_JOB_STATUSES } from '../lib/job-fields';
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

    let body: { status?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { status } = body;
    if (!status || !WRITABLE_JOB_STATUSES.includes(status as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_status', valid: WRITABLE_JOB_STATUSES }) };
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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    // A7: Gate non-active→active transitions against the plan's active job limit.
    // Transitions that do not activate a job (active→paused, active→closed, active→active,
    // paused→paused, paused→closed) consume no slot and bypass the gate entirely.
    if (status === 'active') {
      // Fetch the current job status to determine if this is a slot-consuming transition.
      const currentResult = await client.query<{ status: string }>(
        `SELECT jobs.status FROM jobs JOIN users u ON u.id = jobs.employer_id WHERE jobs.id = $1 AND u.cognito_sub = $2`,
        [jobId, cognitoSub],
      );
      const currentStatus = currentResult.rows[0]?.status;

      if (currentStatus !== 'active') {
        // Non-active→active: this consumes a slot. Enforce the entitlement gate.
        // Lock the employer's users row to serialize all concurrent slot consumers.
        const lockResult = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE`,
          [cognitoSub],
        );
        const userId = lockResult.rows[0]?.id;

        const entitlements = await resolveEntitlements(client, userId);

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
      }
    }

    const result = await client.query(
      `WITH employer_job AS (
         SELECT jobs.id
         FROM jobs
         JOIN users u ON u.id = jobs.employer_id
         WHERE jobs.id = $2 AND u.cognito_sub = $3
       )
       UPDATE jobs SET status = $1
       FROM employer_job
       WHERE jobs.id = employer_job.id
       RETURNING jobs.id, jobs.title, jobs.location, jobs.pay, jobs.job_type, jobs.status, jobs.created_at,
         jobs.pay_min, jobs.pay_max, jobs.pay_interval, jobs.start_date, jobs.expected_duration, jobs.shift_schedule,
         jobs.transportation_required, jobs.work_authorization_required, jobs.language_preference, jobs.number_of_workers_needed,
         jobs.workers_hired AS hired_count,
         GREATEST(jobs.number_of_workers_needed - jobs.workers_hired, 0) AS open_count,
         jobs.trade_category, jobs.required_experience_years, jobs.required_experience_months, jobs.certifications,
         (SELECT COUNT(*)::int FROM job_applications WHERE job_id = $2) AS applicant_count`,
      [status, jobId, cognitoSub],
    );

    // Ownership is enforced by the users join above; rowCount === 0 means forbidden.
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
