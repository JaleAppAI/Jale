import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { corsHeaders } from '../lib/http';
import { hashInviteToken, inviteReadResponse, isTeamManagementEnabled } from '../lib/org-team';

/**
 * GET /employer/invites/{token} — public, no authorizer.
 *
 * The invite page reads what the link holder needs to sign up or sign in:
 * the company's name, the invited email, the contact name the owner typed,
 * whether an employer login already has that email, and when the invite
 * expires. jale_cap.org_team_invite_lookup (133) does the read by the token's
 * SHA-256 and returns nothing else; its users check comes back as a flag.
 *
 * Runs on the jale_api_public login (the only one 133 grants the lookup to),
 * with no RLS caller and no transaction: one read-only statement.
 *
 * The raw token is a bearer secret. It goes to the database only as its
 * hash, and it is never logged: errors are logged by SQLSTATE or name only,
 * since a message could quote the request path.
 */

export const INVITE_LOOKUP_DB_LOGIN = 'jale_api_public';

const LOOKUP_SQL = `SELECT outcome, company_name, email, contact_name, existing_account, expires_at
  FROM jale_cap.org_team_invite_lookup($1)`;

/** Every answer is per-token and names a person: never cached by a browser or proxy. */
function respond(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { ...corsHeaders(), 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
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

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return null;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return respond(404, { error: 'not_found' });

  const hash = hashInviteToken(event.pathParameters?.token as string);
  if (!hash) return respond(404, { error: 'invite_not_found' });

  // Fail closed: this public route must never run on the signed-in API login.
  if (process.env.DB_EXPECTED_LOGIN !== INVITE_LOOKUP_DB_LOGIN) {
    console.error(JSON.stringify({ event: 'invite_lookup_misconfigured', expected: INVITE_LOOKUP_DB_LOGIN }));
    return respond(500, { error: 'internal_error' });
  }

  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    const { rows } = await client.query(LOOKUP_SQL, [hash]);
    const row = rows[0];
    if (!row) throw new Error('invite_lookup_no_row');

    const answer = inviteReadResponse(row.outcome);
    if (answer.error) return respond(answer.statusCode, { error: answer.error });

    return respond(answer.statusCode, {
      companyName: row.company_name,
      email: row.email,
      contactName: row.contact_name ?? null,
      existingAccount: row.existing_account === true,
      expiresAt: isoOrNull(row.expires_at),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'invite_lookup_failed', error: loggableError(err) }));
    return respond(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
