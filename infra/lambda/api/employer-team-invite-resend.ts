import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isUuid } from '../lib/uuid';
import { checkCompliance } from '../legal/check-compliance';
import { resolveCompanyEntitlements } from '../lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import {
  dbBusyResponse, inviteUrl, inviteWriteResponse, isRetryableDbBusy, isTeamManagementEnabled, mintInviteToken,
} from '../lib/org-team';
import { applyMemberAccess } from '../lib/member-access';
import { renderOrgInviteEmail } from '../lib/org-invite-email-template';

/**
 * POST /employer/team/resend (employer organizations, Phase 3): the owner
 * re-sends a pending invite, `{ inviteId, locale }`. A new token replaces the
 * old one (the old link stops working), the invite gets a new week, and a new
 * email is queued. 133's org_team_invite_resend enforces the 60-second
 * cooldown (too_soon, with retryAfterSeconds), 5 resends per invite and 20
 * sends per company a day, and a free seat for an expired invite (it trusts
 * p_seat_limit).
 *
 * Same transaction and order as invite create: the company lock BEFORE the
 * plan, the definer, the email through org_team_invite_queue_email, COMMIT;
 * then, with the client released, a removed member's Cognito user is enabled
 * (Deviation 1). The raw token is never logged.
 */

const CORS_HEADERS = corsHeaders();
const LOG_PREFIX = 'employer-team-invite-resend error:';
const COGNITO_BUDGET_MS = 10_000;

/**
 * The inviting owner's own name, for the email's "invited by" line: their
 * employer_profiles.contact_name, else users.full_name. Their own rows only.
 */
const INVITER_NAME_SQL = `SELECT COALESCE(NULLIF(btrim(ep.contact_name), ''), NULLIF(btrim(u.full_name), '')) AS inviter_name
   FROM users u
   LEFT JOIN employer_profiles ep ON ep.user_id = u.id
  WHERE u.id = $1`;

type Locale = 'en' | 'es';

interface ResendRequest {
  inviteId: string;
  locale: Locale;
}

interface ResendRow {
  outcome: string;
  invite_id: string | null;
  email: string | null;
  contact_name: string | null;
  created_at: Date | string | null;
  expires_at: Date | string | null;
  last_sent_at: Date | string | null;
  company_name: string | null;
  cognito_sub: string | null;
  retry_after_seconds: number | null;
}

/** The frontend's TeamInvite. */
interface TeamInviteBody {
  inviteId: string;
  email: string;
  contactName: string | null;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string;
  expired: false;
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function parseRequest(raw: string | null | undefined): ResendRequest | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw ?? '{}');
  } catch {
    return { error: 'invalid_body' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_body' };
  const { inviteId, locale } = body as Record<string, unknown>;
  if (typeof inviteId !== 'string' || !isUuid(inviteId)) return { error: 'invalid_invite_id' };
  if (locale !== 'en' && locale !== 'es') return { error: 'invalid_locale' };
  return { inviteId, locale };
}

/**
 * PUBLIC_SITE_BASE_URL as inviteUrl() accepts it (https), checked before any
 * DB work so a misconfigured Lambda takes no lock and writes nothing; null
 * when inviteUrl() would throw.
 */
function siteBaseUrl(locale: Locale): string | null {
  const base = process.env.PUBLIC_SITE_BASE_URL ?? '';
  try {
    inviteUrl(base, locale, 'x'.repeat(43));
    return base;
  } catch {
    return null;
  }
}

function iso(value: Date | string | null): string {
  if (value === null) throw new Error('team_invite_row_incomplete');
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function inviteBody(row: ResendRow): TeamInviteBody {
  if (!row.invite_id || !row.email) throw new Error('team_invite_row_incomplete');
  return {
    inviteId: row.invite_id,
    email: row.email,
    contactName: row.contact_name ?? null,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    lastSentAt: iso(row.last_sent_at),
    expired: false,
  };
}

function logError(err: unknown, token: string | undefined): void {
  const code = (err as { code?: unknown } | null)?.code;
  let message = errorMessage(err);
  if (token) message = message.split(token).join('[redacted]');
  console.error(LOG_PREFIX, typeof code === 'string' ? code : '', message);
}

type Outcome =
  | { kind: 'response'; response: APIGatewayProxyResult }
  | { kind: 'resent'; invite: TeamInviteBody; cognitoSub: string | null };

async function resendInvite(cognitoSub: string, request: ResendRequest, baseUrl: string): Promise<Outcome> {
  let client;
  let token: string | undefined;
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
    const { actor } = actorResult;
    if (actor.role !== 'owner') {
      await client.query('ROLLBACK');
      return { kind: 'response', response: response(403, { error: 'owner_required' }) };
    }

    // The company lock first, then the plan (an expired invite needs a free seat).
    const usage = await readCompanyUsage(client, { lock: true });
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');
    const entitlements = await resolveCompanyEntitlements(client, actor.organizationId);

    const minted = mintInviteToken();
    token = minted.token;
    const resent = await client.query<ResendRow>(
      `SELECT outcome, invite_id, email, contact_name, created_at, expires_at, last_sent_at, company_name,
              cognito_sub, retry_after_seconds
         FROM jale_cap.org_team_invite_resend($1, $2, $3)`,
      [request.inviteId, minted.hash, entitlements.foremanSeatLimit],
    );
    const row = resent.rows[0];
    if (!row) throw new Error('team_invite_row_missing');

    if (row.outcome !== 'resent') {
      const mappedResponse = inviteWriteResponse(row.outcome, row.retry_after_seconds);
      await client.query('ROLLBACK');
      const body: Record<string, unknown> = { error: mappedResponse.error };
      if (mappedResponse.retryAfterSeconds !== undefined) body.retryAfterSeconds = mappedResponse.retryAfterSeconds;
      return { kind: 'response', response: response(mappedResponse.statusCode, body) };
    }

    const invite = inviteBody(row);
    const inviter = await client.query<{ inviter_name: string | null }>(INVITER_NAME_SQL, [actor.userId]);
    const email = renderOrgInviteEmail({
      language: request.locale,
      companyName: row.company_name ?? '',
      contactName: row.contact_name,
      inviterName: inviter.rows[0]?.inviter_name ?? null,
      inviteUrl: inviteUrl(baseUrl, request.locale, minted.token),
      expiresAt: new Date(invite.expiresAt),
    });
    await client.query(
      'SELECT jale_cap.org_team_invite_queue_email($1, $2, $3, $4)',
      [invite.inviteId, email.subject, email.bodyText, email.bodyHtml],
    );

    await client.query('COMMIT');
    return { kind: 'resent', invite, cognitoSub: row.cognito_sub ?? null };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* the connection is gone */ } }
    if (err instanceof CompanyUsageRefusedError) {
      return {
        kind: 'response',
        response: employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS),
      };
    }
    if (isRetryableDbBusy(err)) {
      // A lock or statement timeout: nothing was written. Retryable.
      console.warn('employer-team-invite-resend busy:', (err as { code: string }).code);
      return { kind: 'response', response: dbBusyResponse(CORS_HEADERS) };
    }
    logError(err, token);
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
  const baseUrl = siteBaseUrl(request.locale);
  if (!baseUrl) {
    console.error(LOG_PREFIX, '', 'invite_base_url_missing');
    return response(500, { error: 'internal_error' });
  }

  const outcome = await resendInvite(cognitoSub, request, baseUrl);
  if (outcome.kind === 'response') return outcome.response;

  // After COMMIT, with the client released: a re-invited removed member may sign in to accept.
  let accessUpdated = true;
  if (outcome.cognitoSub) {
    try {
      const result = await applyMemberAccess(
        [{ cognitoSub: outcome.cognitoSub, enabled: true }],
        { deadlineAt: Date.now() + COGNITO_BUDGET_MS },
      );
      accessUpdated = result.failed.length === 0;
    } catch (err) {
      // applyMemberAccess never throws; the resend is committed whatever happens here.
      logError(err, undefined);
      accessUpdated = false;
    }
  }
  return response(200, { invite: outcome.invite, accessUpdated });
};
