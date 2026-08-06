import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { enqueueVisibilityTransition, isEffectivelyVisible } from '../lib/job-visibility';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * DELETE /employer/jobs/{jobId} — permanently delete a job the caller owns, plus its
 * dependent rows. Blocked (409) when the job has hired workers.
 *
 * Deletes run in dependency order inside one transaction. Each explicit delete is
 * backed by an employer-scoped FOR DELETE RLS policy (migration 035) keyed on
 * app.current_user_id; job_applications and the matching tables are removed by
 * ON DELETE CASCADE when the job row is deleted.
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
    }>(
      `SELECT jobs.id,
              jobs.status,
              jobs.public_listing_enabled,
              jobs.public_code,
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
    // worker_documents / document_upload_tokens reference jobs(id) with NO ACTION, so
    // they must be removed before the job. NOTE: the KMS-encrypted S3 objects backing
    // worker_documents are intentionally left orphaned here; a future retention job
    // reclaims them (see spec "Out of scope").
    await client.query('DELETE FROM worker_documents WHERE job_id = $1', [jobId]);
    await client.query('DELETE FROM document_upload_tokens WHERE job_id = $1', [jobId]);

    // Cascades job_applications + the matching tables (all ON DELETE CASCADE).
    const del = await client.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    if (del.rowCount !== 1) {
      // Ownership was already proven above, so 0 rows here means a missing DELETE grant
      // or RLS policy rather than a legitimate no-op. Fail loudly instead of returning a
      // false success.
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
