import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { resolveCompanyEntitlements } from '../lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';
import { inviteUrl, inviteWriteResponse, isTeamManagementEnabled, mintInviteToken } from '../lib/org-team';
import { applyMemberAccess } from '../lib/member-access';
import { renderOrgInviteEmail } from '../lib/org-invite-email-template';

/**
 * POST /employer/team/invite (employer organizations, Phase 3): the
 * company's active owner invites a foreman by email. Task 11's dispatcher
 * mounts it; with TEAM_MANAGEMENT_ENABLED off it answers 404 before any DB
 * work.
 *
 * In one transaction: the company lock (readCompanyUsage { lock: true },
 * BEFORE the plan is read, so a concurrent downgrade cannot leave a seat
 * this request spends), the plan's foreman seat limit,
 * jale_cap.org_team_invite_create (133; it trusts p_seat_limit), and the
 * invite email through jale_cap.org_team_invite_queue_email (jale_api has
 * no right on email_outbox). Re-inviting a removed member of this company
 * returns their cognito_sub: their Cognito user is enabled after COMMIT, with
 * the client released (Deviation 1), so they can sign in to accept. A
 * Cognito failure never fails the request; the member-access sync repairs it.
 *
 * PUBLIC_SITE_BASE_URL is checked before BEGIN: a misconfigured Lambda
 * answers 500 without taking the lock. The email names the inviting owner
 * (their own contact name, else full name, read in the same transaction) so
 * the recipient sees who sent it.
 *
 * The raw token is only in the invite link inside the queued email. It is
 * never logged: error lines carry the error's code and message, with the
 * token redacted should a message ever echo it.
 */

const CORS_HEADERS = corsHeaders();
const LOG_PREFIX = 'employer-team-invite-create error:';
const MAX_EMAIL_CHARS = 254;
const MAX_CONTACT_NAME_CHARS = 120;
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

interface InviteRequest {
  email: string;
  contactName: string | null;
  locale: Locale;
}

interface CreateRow {
  outcome: string;
  invite_id: string | null;
  email: string | null;
  contact_name: string | null;
  created_at: Date | string | null;
  expires_at: Date | string | null;
  last_sent_at: Date | string | null;
  company_name: string | null;
  cognito_sub: string | null;
}

export interface TeamInviteBody {
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

/** Code points, as PostgreSQL's char_length counts them. */
function charLength(value: string): number {
  return Array.from(value).length;
}

function parseRequest(raw: string | null | undefined): InviteRequest | { error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw ?? '{}');
  } catch {
    return { error: 'invalid_body' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'invalid_body' };
  const { email, contactName, locale } = body as Record<string, unknown>;

  if (typeof email !== 'string') return { error: 'invalid_email' };
  const trimmedEmail = email.trim();
  if (trimmedEmail === '' || charLength(trimmedEmail) > MAX_EMAIL_CHARS) return { error: 'invalid_email' };

  let name: string | null = null;
  if (contactName !== undefined && contactName !== null) {
    if (typeof contactName !== 'string') return { error: 'invalid_contact_name' };
    const trimmed = contactName.trim();
    if (charLength(trimmed) > MAX_CONTACT_NAME_CHARS) return { error: 'invalid_contact_name' };
    name = trimmed === '' ? null : trimmed;
  }

  if (locale !== 'en' && locale !== 'es') return { error: 'invalid_locale' };
  return { email: trimmedEmail, contactName: name, locale };
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

function inviteBody(row: CreateRow): TeamInviteBody {
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
  | { kind: 'created'; invite: TeamInviteBody; cognitoSub: string | null };

async function createInvite(cognitoSub: string, request: InviteRequest, baseUrl: string): Promise<Outcome> {
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

    // The company lock first, then the plan: a downgrade committed while this
    // request waited is the plan it reads.
    const usage = await readCompanyUsage(client, { lock: true });
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');
    const entitlements = await resolveCompanyEntitlements(client, actor.organizationId);

    const minted = mintInviteToken();
    token = minted.token;
    const created = await client.query<CreateRow>(
      `SELECT outcome, invite_id, email, contact_name, created_at, expires_at, last_sent_at, company_name, cognito_sub
         FROM jale_cap.org_team_invite_create($1, $2, $3, $4)`,
      [request.email, request.contactName, minted.hash, entitlements.foremanSeatLimit],
    );
    const row = created.rows[0];
    if (!row) throw new Error('team_invite_row_missing');

    if (row.outcome !== 'created') {
      const mappedResponse = inviteWriteResponse(row.outcome);
      await client.query('ROLLBACK');
      return { kind: 'response', response: response(mappedResponse.statusCode, { error: mappedResponse.error }) };
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
    return { kind: 'created', invite, cognitoSub: row.cognito_sub ?? null };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* the connection is gone */ } }
    if (err instanceof CompanyUsageRefusedError) {
      // The definer says the caller stopped being an active member while waiting for the lock.
      return {
        kind: 'response',
        response: employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS),
      };
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

  const outcome = await createInvite(cognitoSub, request, baseUrl);
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
      // applyMemberAccess never throws; the invite is committed whatever happens here.
      logError(err, undefined);
      accessUpdated = false;
    }
  }
  return response(201, { invite: outcome.invite, accessUpdated });
};
