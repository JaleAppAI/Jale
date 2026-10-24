import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { isMembershipConflict, isTeamManagementEnabled } from '../lib/org-team';

/**
 * /employer/team/membership, for any employer login. Served through the team
 * dispatcher (employer-team.ts), which answers 404 for every route while the
 * team-management flag is off; this handler reads nothing from the path.
 *
 * GET (not flagged here): the caller's own membership from 134's
 * org_team_membership(). None: 403 no_organization. Suspended or removed:
 * 403 membership_inactive with the status and whether a live invite of the
 * same company waits for them. Active: 200 { userId, organizationId, role,
 * companyName }.
 *
 * POST (flagged), body { companyName }: "start my own company" for a login
 * with no membership (Open decision 18). 118's employer_ensure_organization
 * creates the company and the owner membership, but it returns ANY existing
 * membership's company and takes no company lock, so an invite accept for
 * the same login can land between the pre-check and the ensure:
 *   - committed before the ensure reads: the ensure returns the accepted
 *     company, so the membership is re-read after it and anything but the
 *     caller as the active owner of the returned company is 409
 *     already_member (never a false "201 owner");
 *   - in flight while the ensure inserts: 23505 on the members primary key,
 *     also 409 already_member.
 * The company's display name is the owner's employer_profiles company_name
 * (Deviation 8), so the start seeds it in the same transaction: an existing
 * non-empty company_name is kept, otherwise the typed name is written, and the
 * effective name is mirrored into users.full_name as the profile PATCH does
 * for an owner. Both writes are covered by 111's change log, so the audit
 * context (employer.profile_update) is stated first. Like the team
 * delegates, the start is gated on the current ToS (checkCompliance).
 */

const CORS_HEADERS = corsHeaders();
const COMPANY_NAME_MAX = 120;
const NOT_AN_EMPLOYER = 'only an employer login has a company';

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

type MembershipRow = {
  user_id: string;
  organization_id: string;
  role: 'owner' | 'foreman';
  status: 'active' | 'suspended' | 'removed';
  company_name: string;
  has_live_invite: boolean;
};

const MEMBERSHIP_SQL = `SELECT user_id, organization_id, role, status, company_name, has_live_invite
   FROM jale_cap.org_team_membership()`;

function parseCompanyName(raw: string | null): string | null {
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const name = (body as Record<string, unknown>).companyName;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > COMPANY_NAME_MAX) return null;
  return trimmed;
}

async function getMembership(client: PoolClient): Promise<APIGatewayProxyResult> {
  const res = await client.query<MembershipRow>(MEMBERSHIP_SQL);
  await client.query('COMMIT');
  const row = res.rows[0];
  if (!row) return response(403, { error: 'no_organization' });
  if (row.status !== 'active') {
    return response(403, { error: 'membership_inactive', membershipStatus: row.status, hasInvite: row.has_live_invite === true });
  }
  return response(200, { userId: row.user_id, organizationId: row.organization_id, role: row.role, companyName: row.company_name });
}

async function startCompany(
  client: PoolClient,
  event: APIGatewayProxyEvent,
  cognitoSub: string,
  companyName: string,
): Promise<APIGatewayProxyResult> {
  const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
  if (!compliance.userExists) {
    await client.query('ROLLBACK');
    return response(409, { error: 'user_not_provisioned' });
  }
  if (!compliance.compliant) {
    await client.query('ROLLBACK');
    return response(403, { error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion });
  }

  const before = await client.query<MembershipRow>(MEMBERSHIP_SQL);
  if (before.rows.length > 0) {
    await client.query('ROLLBACK');
    return response(409, { error: 'already_member' });
  }

  const ensured = await client.query<{ org: string }>('SELECT public.employer_ensure_organization($1) AS org', [companyName]);
  const organizationId = ensured.rows[0]?.org;

  // 118 returns an existing membership's company too: only a new owner row of
  // the returned company is a start.
  const after = await client.query<MembershipRow>(MEMBERSHIP_SQL);
  const row = after.rows[0];
  if (!organizationId || !row || row.organization_id !== organizationId || row.role !== 'owner' || row.status !== 'active') {
    await client.query('ROLLBACK');
    return response(409, { error: 'already_member' });
  }

  // The company's name, as every Phase 3 reader shows it (the owner's
  // profile). employer_profiles_self and users_isolation_update admit the
  // caller's own rows by app.current_user_id.
  await setAuditContext(client, auditCaller(event, { kind: 'employer', id: row.user_id }, 'web'), 'employer.profile_update');
  await client.query(
    `UPDATE users
        SET full_name = COALESCE((SELECT NULLIF(ep.company_name, '') FROM employer_profiles ep WHERE ep.user_id = users.id), $1)
      WHERE cognito_sub = $2`,
    [companyName, cognitoSub],
  );
  await client.query(
    `INSERT INTO employer_profiles (user_id, company_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       company_name = COALESCE(NULLIF(employer_profiles.company_name, ''), EXCLUDED.company_name),
       updated_at = NOW()`,
    [row.user_id, companyName],
  );

  await client.query('COMMIT');
  return response(201, { organizationId, role: 'owner' });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return response(404, { error: 'not_found' });
  if (method === 'POST' && !isTeamManagementEnabled()) return response(404, { error: 'not_found' });
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return response(401, { error: 'unauthorized' });

  let companyName: string | null = null;
  if (method === 'POST') {
    companyName = parseCompanyName(event.body);
    if (companyName === null) return response(400, { error: 'invalid_company_name' });
  }

  let client: PoolClient | undefined;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);
    return companyName === null ? await getMembership(client) : await startCompany(client, event, cognitoSub, companyName);
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* already failed */ } }
    if (isMembershipConflict(err)) return response(409, { error: 'already_member' });
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e?.code === '42501' && typeof e.message === 'string' && e.message.includes(NOT_AN_EMPLOYER)) {
      return response(403, { error: 'employer_required' });
    }
    console.error('employer-membership error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
