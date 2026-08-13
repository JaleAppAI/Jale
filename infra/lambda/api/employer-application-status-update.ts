import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { APPLICATION_STATUSES } from '../lib/job-fields';
import { enqueueVisibilityTransition, isEffectivelyVisible } from '../lib/job-visibility';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    const workerId = event.pathParameters?.workerId;
    if (!jobId || !workerId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_params', required: ['jobId', 'workerId'] }) };
    }
    if (!UUID_REGEX.test(jobId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_id' }) };
    }
    if (!UUID_REGEX.test(workerId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_worker_id' }) };
    }

    let body: { status?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }

    const { status } = body;
    if (!status || !APPLICATION_STATUSES.includes(status as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_status', valid: APPLICATION_STATUSES }) };
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

    // status/public_listing_enabled/public_code are read here -- BEFORE the
    // application UPDATE below -- so the visibility-event decision has a
    // clean "before" snapshot. sync_job_hired_counts() (029, SECURITY
    // DEFINER) flips jobs.status between 'active' and 'filled' as an AFTER
    // trigger on job_applications, in this same transaction, whenever the
    // UPDATE below pushes workers_hired past/below number_of_workers_needed
    // -- entirely bypassing the visibility outbox (062) unless this handler
    // explicitly re-reads status afterward and enqueues the transition.
    const jobCheck = await client.query(
      `SELECT jobs.id, jobs.number_of_workers_needed, jobs.workers_hired,
              jobs.status, jobs.public_listing_enabled, jobs.public_code
       FROM jobs
       JOIN users u ON u.id = jobs.employer_id
       WHERE jobs.id = $1 AND u.cognito_sub = $2
       FOR UPDATE OF jobs`,
      [jobId, cognitoSub],
    );
    if (jobCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    const application = await client.query(
      `SELECT id, status
       FROM job_applications
       WHERE job_id = $1 AND worker_id = $2
       FOR UPDATE`,
      [jobId, workerId],
    );
    if (application.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const job = jobCheck.rows[0];
    const currentStatus = application.rows[0].status;
    if (status === 'hired' && currentStatus !== 'hired' && job.workers_hired >= job.number_of_workers_needed) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'headcount_full' }) };
    }

    const result = await client.query(
      `UPDATE job_applications
       SET status = $1
       WHERE job_id = $2 AND worker_id = $3
       RETURNING id AS application_id, job_id, worker_id, status, applied_at, updated_at`,
      [status, jobId, workerId],
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'concurrent_modification' }) };
    }

    // Re-read status AFTER the application UPDATE: sync_job_hired_counts()
    // runs as an AFTER trigger on job_applications within this same
    // transaction, so by this point jobs.status already reflects any
    // active<->filled flip the hire/un-hire just caused.
    // public_listing_enabled is untouched by that trigger, so job.public_listing_enabled
    // (read above, before the update) holds for both sides of the comparison.
    if (job.public_listing_enabled === true && job.public_code) {
      const jobAfter = await client.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
      const statusAfter: string = jobAfter.rows[0]?.status ?? job.status;
      const wasVisible = isEffectivelyVisible(job.status, job.public_listing_enabled);
      const isVisible = isEffectivelyVisible(statusAfter, job.public_listing_enabled);
      await enqueueVisibilityTransition(client, jobId, job.public_code, wasVisible, isVisible);
    }

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-application-status-update error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
