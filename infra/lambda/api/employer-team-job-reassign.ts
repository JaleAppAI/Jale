import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import { dbBusyResponse, isAssigneeRefusal, isRetryableDbBusy, isTeamManagementEnabled } from '../lib/org-team';
import { isUuid } from '../lib/uuid';

/**
 * POST /employer/team/reassign (a delegate of the team dispatcher; the
 * spec's PATCH /employer/jobs/{id}/assignee), body { jobId, userId }: the
 * company's active owner hands one job to another active member.
 *
 * Under the company lock (taken first, 128's order), the job must be one of
 * the company's, and the assignee an active member of it. The move clears
 * the billing mark (a paused job stays paused; Open decision 2), and 135's
 * foreign key moves the job's conversations in the same statement.
 * jobs.created_by_user_id (the poster) is never written. 129's trigger
 * re-checks the assignee: its four assignee refusals answer 409
 * invalid_assignee; employer_inactive_for_activation is not expected (the
 * move never activates a job) and stays a 500.
 */

const CORS_HEADERS = corsHeaders();

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function parseBody(raw: string | null): { jobId: string; userId: string } | { error: string } {
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: 'invalid_body' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_body' };
  const { jobId, userId } = body as Record<string, unknown>;
  if (typeof jobId !== 'string' || !isUuid(jobId)) return { error: 'invalid_job_id' };
  if (typeof userId !== 'string' || !isUuid(userId)) return { error: 'invalid_user_id' };
  return { jobId: jobId.toLowerCase(), userId: userId.toLowerCase() };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return response(404, { error: 'not_found' });
  if (event.httpMethod !== 'POST') return response(404, { error: 'not_found' });
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return response(401, { error: 'unauthorized' });

  const parsed = parseBody(event.body);
  if ('error' in parsed) return response(400, { error: parsed.error });
  const { jobId, userId } = parsed;

  let client: PoolClient | undefined;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return response(409, { error: 'user_not_provisioned' });
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return response(403, { error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion });
    }

    const actorResult = await resolveEmployerActor(client, cognitoSub);
    if (!actorResult.ok) {
      await client.query('ROLLBACK');
      if (actorResult.status === 409) return response(403, { error: 'employer_required' });
      return employerActorFailureResponse(actorResult, CORS_HEADERS);
    }
    const { actor } = actorResult;
    if (actor.role !== 'owner') {
      await client.query('ROLLBACK');
      return response(403, { error: 'owner_required' });
    }

    // 1. The company lock, before the job and member reads and the move.
    // The owner role is not re-checked after it: in v1 the role cannot change
    // (no ownership transfer; the owner is never suspended or removed, 118),
    // and the definer re-checks that the caller is still an active member. If
    // ownership transfer ever lands, re-read the caller's role here.
    const usage = await readCompanyUsage(client, { lock: true });
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');

    // 2. One of the company's jobs.
    const jobRes = await client.query<{ employer_id: string }>(
      'SELECT employer_id FROM jobs WHERE id = $1 AND employer_id = ANY($2::uuid[])',
      [jobId, actor.scopeUserIds],
    );
    const current = jobRes.rows[0]?.employer_id;
    if (!current) {
      await client.query('ROLLBACK');
      return response(404, { error: 'not_found' });
    }

    // 3. Already theirs: nothing to write.
    if (current === userId) {
      await client.query('COMMIT');
      return response(200, { jobId, assigneeUserId: userId, changed: false });
    }

    // 4. The assignee: an active member of this company.
    const assigneeRes = await client.query<{ status: string }>(
      'SELECT status FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [userId, actor.organizationId],
    );
    if (assigneeRes.rows[0]?.status !== 'active') {
      await client.query('ROLLBACK');
      return response(409, { error: 'invalid_assignee' });
    }

    // 5. The move. The employer_id guard turns a job deleted since step 2 into a 404.
    const moved = await client.query(
      `UPDATE jobs
          SET employer_id = $2, billing_paused_at = NULL, updated_at = now()
        WHERE id = $1 AND employer_id = $3`,
      [jobId, userId, current],
    );
    if (moved.rowCount !== 1) {
      await client.query('ROLLBACK');
      return response(404, { error: 'not_found' });
    }

    await client.query('COMMIT');
    return response(200, { jobId, assigneeUserId: userId, changed: true });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    if (err instanceof CompanyUsageRefusedError) {
      return employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS);
    }
    if (isAssigneeRefusal(err)) return response(409, { error: 'invalid_assignee' });
    if (isRetryableDbBusy(err)) {
      // A lock or statement timeout: nothing was moved. Retryable.
      console.warn('employer-team-job-reassign busy:', (err as { code: string }).code);
      return dbBusyResponse(CORS_HEADERS);
    }
    console.error('employer-team-job-reassign error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
