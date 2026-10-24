import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { resolveCompanyEntitlements } from '../lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import { isTeamManagementEnabled } from '../lib/org-team';

/**
 * GET /employer/team/members (a delegate of the team dispatcher): the Team
 * page's data for the company's active owner. The seats come from the
 * company's usage (128) and plan; the members and the pending invites from
 * 134's definers, which leave removed members out and flag expired invites.
 * A read: the usage is taken without the company lock.
 */

const CORS_HEADERS = corsHeaders();

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

type MemberRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'foreman';
  status: 'active' | 'suspended' | 'removed';
  billing_suspended: boolean;
  joined_at: Date | string;
  active_jobs: number;
  open_jobs: number;
};

type InviteRow = {
  invite_id: string;
  email: string;
  contact_name: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  last_sent_at: Date | string;
  expired: boolean;
};

const NOT_ACTIVE_OWNER = 'the caller is not the active owner';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return response(404, { error: 'not_found' });
  if (event.httpMethod !== 'GET') return response(404, { error: 'not_found' });
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return response(401, { error: 'unauthorized' });

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

    const usage = await readCompanyUsage(client);
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');
    const entitlements = await resolveCompanyEntitlements(client, actor.organizationId);

    const membersRes = await client.query<MemberRow>(
      `SELECT user_id, email, display_name, role, status, billing_suspended, joined_at, active_jobs, open_jobs
         FROM jale_cap.org_team_members()`,
    );
    const invitesRes = await client.query<InviteRow>(
      `SELECT invite_id, email, contact_name, created_at, expires_at, last_sent_at, expired
         FROM jale_cap.org_team_invites()`,
    );
    await client.query('COMMIT');

    return response(200, {
      seats: {
        limit: entitlements.foremanSeatLimit,
        active: usage.activeForemen,
        pending: usage.pendingInvites,
        suspended: usage.suspendedForemen,
      },
      // 134 already leaves removed members out; the filter keeps the contract if it ever stops.
      members: membersRes.rows
        .filter((m) => m.status === 'active' || m.status === 'suspended')
        .map((m) => ({
          userId: m.user_id,
          name: m.display_name,
          email: m.email,
          role: m.role,
          status: m.status,
          billingSuspended: m.billing_suspended === true,
          joinedAt: iso(m.joined_at),
          activeJobs: Number(m.active_jobs),
          openJobs: Number(m.open_jobs),
        })),
      invites: invitesRes.rows.map((i) => ({
        inviteId: i.invite_id,
        email: i.email,
        contactName: i.contact_name,
        createdAt: iso(i.created_at),
        expiresAt: iso(i.expires_at),
        lastSentAt: iso(i.last_sent_at),
        expired: i.expired === true,
      })),
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    if (err instanceof CompanyUsageRefusedError) {
      return employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS);
    }
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e?.code === '42501' && typeof e.message === 'string' && e.message.includes(NOT_ACTIVE_OWNER)) {
      // The caller stopped being the active owner after resolveEmployerActor read them.
      return response(403, { error: 'owner_required' });
    }
    console.error('employer-team-list error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
