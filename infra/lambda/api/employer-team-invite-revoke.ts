import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isUuid } from '../lib/uuid';
import { checkCompliance } from '../legal/check-compliance';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import { dbBusyResponse, inviteWriteResponse, isRetryableDbBusy, isTeamManagementEnabled } from '../lib/org-team';
import { applyMemberAccess } from '../lib/member-access';

/**
 * POST /employer/team/revoke (employer organizations, Phase 3): the owner
 * revokes a pending invite, `{ inviteId }`.
 *
 * jale_cap.org_team_invite_revoke (133) takes the company lock itself and
 * frees no seat this request could spend, so no usage read or plan is
 * needed here. When the invite was a removed member's re-invite it returns
 * their cognito_sub: after COMMIT, with the client released, their Cognito
 * user is signed out and disabled again (Deviation 1). A Cognito failure
 * never fails the request; the member-access sync repairs it.
 */

const CORS_HEADERS = corsHeaders();
const LOG_PREFIX = 'employer-team-invite-revoke error:';
const COGNITO_BUDGET_MS = 10_000;

interface RevokeRow {
  outcome: string;
  cognito_sub: string | null;
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function parseRequest(raw: string | null | undefined): { inviteId: string } | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw ?? '{}');
  } catch {
    return { error: 'invalid_body' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_body' };
  const { inviteId } = body as Record<string, unknown>;
  if (typeof inviteId !== 'string' || !isUuid(inviteId)) return { error: 'invalid_invite_id' };
  return { inviteId };
}

function logError(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(LOG_PREFIX, typeof code === 'string' ? code : '', errorMessage(err));
}

type Outcome =
  | { kind: 'response'; response: APIGatewayProxyResult }
  | { kind: 'revoked'; cognitoSub: string | null };

async function revokeInvite(cognitoSub: string, inviteId: string): Promise<Outcome> {
  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const requiredVersion = process.env.REQUIRED_TOS_VERSION!;
    const compliance = await checkCompliance(client, cognitoSub, requiredVersion);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return { kind: 'response', response: response(409, { error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return {
        kind: 'response',
        response: response(403, { error: 'legal_required', requiredVersion, currentVersion: compliance.currentVersion }),
      };
    }

    const actorResult = await resolveEmployerActor(client, cognitoSub);
    if (!actorResult.ok) {
      await client.query('ROLLBACK');
      // compliance proved the user exists, so "not provisioned" means "not an employer".
      if (actorResult.status === 409) return { kind: 'response', response: response(403, { error: 'employer_required' }) };
      return { kind: 'response', response: employerActorFailureResponse(actorResult, CORS_HEADERS) };
    }
    if (actorResult.actor.role !== 'owner') {
      await client.query('ROLLBACK');
      return { kind: 'response', response: response(403, { error: 'owner_required' }) };
    }

    const revoked = await client.query<RevokeRow>(
      'SELECT outcome, cognito_sub FROM jale_cap.org_team_invite_revoke($1)',
      [inviteId],
    );
    const row = revoked.rows[0];
    if (!row) throw new Error('team_invite_row_missing');

    if (row.outcome !== 'revoked') {
      const mappedResponse = inviteWriteResponse(row.outcome);
      await client.query('ROLLBACK');
      return { kind: 'response', response: response(mappedResponse.statusCode, { error: mappedResponse.error }) };
    }

    await client.query('COMMIT');
    return { kind: 'revoked', cognitoSub: row.cognito_sub ?? null };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* the connection is gone */ } }
    if (isRetryableDbBusy(err)) {
      // A lock or statement timeout: nothing was written. Retryable.
      console.warn('employer-team-invite-revoke busy:', (err as { code: string }).code);
      return { kind: 'response', response: dbBusyResponse(CORS_HEADERS) };
    }
    logError(err);
    return { kind: 'response', response: response(500, { error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return response(404, { error: 'not_found' });
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return response(401, { error: 'unauthorized' });
  if (event.httpMethod !== 'POST') return response(404, { error: 'not_found' });

  const request = parseRequest(event.body);
  if ('error' in request) return response(400, { error: request.error });

  const outcome = await revokeInvite(cognitoSub, request.inviteId);
  if (outcome.kind === 'response') return outcome.response;

  // After COMMIT, with the client released: a removed member's re-invite is gone, so they lose sign-in again.
  let accessUpdated = true;
  if (outcome.cognitoSub) {
    try {
      const result = await applyMemberAccess(
        [{ cognitoSub: outcome.cognitoSub, enabled: false }],
        { deadlineAt: Date.now() + COGNITO_BUDGET_MS },
      );
      accessUpdated = result.failed.length === 0;
    } catch (err) {
      // applyMemberAccess never throws; the revoke is committed whatever happens here.
      logError(err);
      accessUpdated = false;
    }
  }
  return response(200, { revoked: true, accessUpdated });
};
