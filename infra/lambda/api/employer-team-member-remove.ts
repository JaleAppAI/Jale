import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import { applyMemberAccess } from '../lib/member-access';
import { dbBusyResponse, isAssigneeRefusal, isRetryableDbBusy, isTeamManagementEnabled, removeResponse } from '../lib/org-team';
import { isUuid } from '../lib/uuid';

/**
 * POST /employer/team/remove (a delegate of the team dispatcher), body
 * { userId, reassignTo }: the company's active owner removes a foreman and
 * hands every job they hold to another active member, in one transaction.
 *
 *   1. The company lock first (employer_org_usage(true), 128's order:
 *      organizations, then members, then jobs). Every writer of a company's
 *      members and jobs holds it, so nothing below changes underneath.
 *   2. The target and the assignee, read plainly from organization_members
 *      within the caller's company.
 *   3. Every job of the target moves to the assignee, whatever its status. A
 *      billing-paused job stays paused but loses the billing mark (the
 *      assignee is active, so billing's restore must not resume it; Open
 *      decision 2). 135's foreign key moves each job's conversations in the
 *      same statement. jobs.created_by_user_id (the poster) is never written.
 *      hire_contact_name / hire_contact_phone keep naming the removed
 *      foreman; renaming the contact is Phase 4's.
 *   4. 134's org_team_remove_member removes the target (it re-takes the same
 *      lock and refuses with has_jobs if a job still names them).
 *   5. After COMMIT, with the client released, the target's Cognito user is
 *      disabled. A Cognito failure never undoes the removal: the answer is
 *      still 200 with accessUpdated false, and the member-access sync repairs
 *      it.
 *
 * Moving changes jobs.employer_id, part of the (id, employer_id) key 135
 * added, so each moved row takes FOR UPDATE: the transaction is kept short
 * and does nothing after the move but the removal.
 */

const CORS_HEADERS = corsHeaders();
const COGNITO_BUDGET_MS = 10_000;

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

type MemberRow = { user_id: string; role: 'owner' | 'foreman'; status: 'active' | 'suspended' | 'removed' };

function parseBody(raw: string | null): { userId: string; reassignTo: string } | { error: string } {
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { error: 'invalid_body' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_body' };
  const { userId, reassignTo } = body as Record<string, unknown>;
  if (typeof userId !== 'string' || !isUuid(userId)) return { error: 'invalid_user_id' };
  if (typeof reassignTo !== 'string' || !isUuid(reassignTo)) return { error: 'invalid_reassign_to' };
  return { userId: userId.toLowerCase(), reassignTo: reassignTo.toLowerCase() };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return response(404, { error: 'not_found' });
  if (event.httpMethod !== 'POST') return response(404, { error: 'not_found' });
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return response(401, { error: 'unauthorized' });

  const parsed = parseBody(event.body);
  if ('error' in parsed) return response(400, { error: parsed.error });
  const { userId, reassignTo } = parsed;

  let client: PoolClient | undefined;
  let removedSub: string | null = null;
  let movedJobs = 0;
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

    // 1. The company lock, before any member read or job write.
    const usage = await readCompanyUsage(client, { lock: true });
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');

    // 2. The target and the assignee, this company's rows only.
    const membersRes = await client.query<MemberRow>(
      `SELECT user_id, role, status
         FROM organization_members
        WHERE organization_id = $1
          AND user_id = ANY($2::uuid[])`,
      [actor.organizationId, [userId, reassignTo]],
    );
    const targetRow = membersRes.rows.find((m) => m.user_id === userId);
    const assigneeRow = membersRes.rows.find((m) => m.user_id === reassignTo);
    const refusal =
      !targetRow ? removeResponse('not_found')
      : targetRow.role === 'owner' ? removeResponse('is_owner')
      : targetRow.status === 'removed' ? removeResponse('already_removed')
      : reassignTo === userId || !assigneeRow || assigneeRow.status !== 'active'
        ? { statusCode: 409, error: 'invalid_assignee' }
        : null;
    if (refusal) {
      await client.query('ROLLBACK');
      return response(refusal.statusCode, { error: refusal.error });
    }

    // 3. Every job of the target, to the assignee; conversations follow (135).
    const moved = await client.query<{ id: string }>(
      `UPDATE jobs
          SET employer_id = $1, billing_paused_at = NULL, updated_at = now()
        WHERE employer_id = $2
        RETURNING id`,
      [reassignTo, userId],
    );
    movedJobs = moved.rows.length;

    // 4. The removal itself.
    const removeRes = await client.query<{ outcome: string; cognito_sub: string | null }>(
      'SELECT outcome, cognito_sub FROM jale_cap.org_team_remove_member($1)',
      [userId],
    );
    const outcome = removeRes.rows[0]?.outcome;
    if (typeof outcome !== 'string') throw new Error('org_team_remove_member returned no outcome');
    const mapped = removeResponse(outcome);
    if (outcome !== 'removed') {
      await client.query('ROLLBACK');
      return response(mapped.statusCode, { error: mapped.error });
    }
    removedSub = removeRes.rows[0].cognito_sub;

    await client.query('COMMIT');
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    if (err instanceof CompanyUsageRefusedError) {
      return employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS);
    }
    if (isAssigneeRefusal(err)) return response(409, { error: 'invalid_assignee' });
    if (isRetryableDbBusy(err)) {
      // A lock or statement timeout: nothing was moved or removed. Retryable.
      console.warn('employer-team-member-remove busy:', (err as { code: string }).code);
      return dbBusyResponse(CORS_HEADERS);
    }
    console.error('employer-team-member-remove error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
    client = undefined;
  }

  // 5. After COMMIT, the client released: sign the removed member out. A
  // removed member with no cognito_sub has no Cognito user to disable, so
  // nothing is left to converge and accessUpdated stays true.
  let accessUpdated = true;
  if (removedSub) {
    try {
      const result = await applyMemberAccess(
        [{ cognitoSub: removedSub, enabled: false }],
        { deadlineAt: Date.now() + COGNITO_BUDGET_MS },
      );
      accessUpdated = result.failed.length === 0;
    } catch (err) {
      // applyMemberAccess does not throw; if it ever does, the removal stands.
      console.error('employer-team-member-remove cognito error:', errorMessage(err));
      accessUpdated = false;
    }
  }
  return response(200, { removed: true, movedJobs, accessUpdated });
};
