import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { checkCompliance } from '../legal/check-compliance';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders } from '../lib/http';
import { applyMemberAccess } from '../lib/member-access';
import { acceptResponse, hashInviteToken, isMembershipConflict, isTeamManagementEnabled } from '../lib/org-team';

/**
 * POST /employer/invites/{token} — employer authorizer.
 *
 * A signed-in employer login accepts an invite: one with no company yet (its
 * confirmation found no usable invite), or a removed foreman of the inviting
 * company rejoining. jale_cap.org_team_invite_accept (133) takes the company
 * lock, matches the invite's email against the caller's, and either adds the
 * membership (`accepted`) or reactivates the removed one (`rejoined`).
 *
 * Deliberately no resolveEmployerActor: that gate refuses exactly the logins
 * this route is for (no organization, or a removed membership). The legal
 * gate still applies.
 *
 * A `rejoined` member's Cognito user is enabled after COMMIT, with the DB
 * client released first. Invite create and resend already enabled it so the
 * person could sign in; this call is idempotent and repairs a missed enable.
 * A Cognito failure never turns the committed accept into an error: the
 * 15-minute member-access sync converges it.
 *
 * The raw token goes to the database only as its hash and is never logged.
 */

const ACCEPT_SQL = 'SELECT outcome, organization_id FROM jale_cap.org_team_invite_accept($1)';
const COGNITO_BUDGET_MS = 10_000;

function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

/**
 * What to log for an error: its SQLSTATE, our own snake_case code (at most
 * 40 characters, so never a 43-character token), or its class name.
 */
function loggableError(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && /^[A-Z0-9]{5}$/.test(e.code)) return e.code;
  if (typeof e?.message === 'string' && /^[a-z_]{1,40}$/.test(e.message)) return e.message;
  if (typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name)) return e.name;
  return 'unknown';
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return respond(404, { error: 'not_found' });

  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return respond(401, { error: 'unauthorized' });

  const hash = hashInviteToken(event.pathParameters?.token as string);
  if (!hash) return respond(404, { error: 'invite_not_found' });

  let client: PoolClient | undefined;
  let result: { outcome: 'accepted' | 'rejoined'; organizationId: string };
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const requiredVersion = process.env.REQUIRED_TOS_VERSION!;
    const compliance = await checkCompliance(client, cognitoSub, requiredVersion);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return respond(409, { error: 'user_not_provisioned' });
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return respond(403, { error: 'legal_required', requiredVersion, currentVersion: compliance.currentVersion });
    }

    let row: { outcome: string; organization_id: string | null } | undefined;
    try {
      ({ rows: [row] } = await client.query(ACCEPT_SQL, [hash]));
    } catch (err) {
      // 133 maps this itself; kept for any path that still raises it (an
      // accept or start-company for this login in another company won).
      if (!isMembershipConflict(err)) throw err;
      await client.query('ROLLBACK');
      console.warn(JSON.stringify({ event: 'invite_accept_refused', outcome: 'already_member', cognitoSub }));
      return respond(409, { error: 'already_member' });
    }
    if (!row) throw new Error('invite_accept_no_row');

    const answer = acceptResponse(row.outcome);
    if (answer.error) {
      await client.query('ROLLBACK');
      console.warn(JSON.stringify({ event: 'invite_accept_refused', outcome: row.outcome, cognitoSub }));
      return respond(answer.statusCode, { error: answer.error });
    }
    if ((row.outcome !== 'accepted' && row.outcome !== 'rejoined') || !row.organization_id) {
      throw new Error('invite_accept_unexpected_row');
    }

    await client.query('COMMIT');
    result = { outcome: row.outcome, organizationId: row.organization_id };
    console.log(JSON.stringify({ event: 'invite_accept_succeeded', outcome: row.outcome, cognitoSub }));
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ } }
    console.error(JSON.stringify({ event: 'invite_accept_failed', error: loggableError(err) }));
    return respond(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }

  if (result.outcome === 'rejoined') {
    try {
      await applyMemberAccess([{ cognitoSub, enabled: true }], { deadlineAt: Date.now() + COGNITO_BUDGET_MS });
    } catch (err) {
      // applyMemberAccess never throws; belt and braces for the committed accept.
      console.error(JSON.stringify({ event: 'invite_accept_enable_failed', error: loggableError(err) }));
    }
  }

  return respond(200, result);
};
