import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { enqueueVisibilityTransition, isEffectivelyVisible } from '../lib/job-visibility';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * DELETE /employer/jobs/{jobId} — permanently delete a job the caller owns, plus its
 * dependent rows. Blocked (409) when the job has hired workers.
 *
 * One transaction. After the ownership proof the employer's users.id is the
 * caller context for the transaction (app.current_internal_user_id, next to
 * the Cognito sub). The conversations are deleted explicitly, then the job;
 * everything else that hangs off the job -- job_applications, the matching
 * tables, job-scoped worker_documents and document_upload_tokens (with their
 * slots) -- goes with it through ON DELETE CASCADE.
 */
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

    // Ownership + hired-worker guard, locking the job row for the transaction.
    // Ownership is enforced by the users join; rowCount === 0 means forbidden (and does
    // not distinguish "not found" from "not yours", to avoid leaking job existence).
    // status/public_listing_enabled/public_code are captured here too, for the
    // visibility-event hook below -- deleting an effectively-visible job must
    // notify the same way turning off its listing would.
    const owned = await client.query<{
      id: string; hired_count: number; status: string; public_listing_enabled: boolean; public_code: string;
      employer_user_id: string;
    }>(
      `SELECT jobs.id,
              jobs.status,
              jobs.public_listing_enabled,
              jobs.public_code,
              u.id AS employer_user_id,
              (SELECT COUNT(*)::int FROM job_applications
                 WHERE job_id = jobs.id AND status = 'hired') AS hired_count
       FROM jobs JOIN users u ON u.id = jobs.employer_id
       WHERE jobs.id = $1 AND u.cognito_sub = $2
       FOR UPDATE OF jobs`,
      [jobId, cognitoSub],
    );
    if (owned.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }
    if (owned.rows[0].hired_count > 0) {
      await client.query('ROLLBACK');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_has_hired_workers' }) };
    }
    const ownedRow = owned.rows[0];
    const wasEffectivelyVisible = isEffectivelyVisible(ownedRow.status, ownedRow.public_listing_enabled);

    // The employer's users.id, proven by the ownership join above, for the
    // rest of this transaction.
    await setInternalUserRlsContext(client, ownedRow.employer_user_id);
    // The deletes below cascade into tables the change log covers; the
    // employer is named as their actor.
    await setAuditContext(
      client,
      auditCaller(event, { kind: 'employer', id: ownedRow.employer_user_id }, 'web'),
      'employer.job_delete',
    );

    // Enqueue the removal notice BEFORE deleting the job row, while jobs.id = $1
    // still exists to be referenced. A 'removed' event must outlive the job it
    // describes (the whole point is notifying Google after the row is gone), so
    // this must never be ordered after the DELETE below -- doing so would either
    // violate a FK on job_visibility_events.job_id (if one exists) or, if that FK
    // cascades, have the DELETE immediately wipe out the very event we just wrote.
    // One-sided transition: deletion always makes the job non-visible afterward
    // (isVisible=false), so this only ever enqueues 'removed', never 'published'.
    if (ownedRow.public_code) {
      await enqueueVisibilityTransition(client, jobId, ownedRow.public_code, wasEffectivelyVisible, false);
    }

    // job_conversations first: cascades its messages/outbox and clears the
    // application_id RESTRICT before job_applications cascade-deletes with the job.
    await client.query('DELETE FROM job_conversations WHERE job_id = $1', [jobId]);
    // Any conversation left on the job would surface as a foreign-key error
    // below; name it instead.
    const leftover = await client.query<{ remaining: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM job_conversations WHERE job_id = $1) AS remaining',
      [jobId],
    );
    if (leftover.rows[0]?.remaining === true) {
      await client.query('ROLLBACK');
      console.error('employer-jobs-delete error: job conversations remain after the delete');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
    }

    // Cascades job_applications, the matching tables, and the job-scoped
    // worker_documents and document_upload_tokens (all ON DELETE CASCADE).
    // NOTE: the KMS-encrypted S3 objects backing those documents are
    // intentionally left orphaned here; a future retention job reclaims them.
    const del = await client.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    if (del.rowCount !== 1) {
      // Ownership was already proven above, so 0 rows here is unexpected. Fail loudly
      // instead of returning a false success.
      await client.query('ROLLBACK');
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
    }

    await client.query('COMMIT');
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ deleted: true, id: jobId }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-jobs-delete error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
