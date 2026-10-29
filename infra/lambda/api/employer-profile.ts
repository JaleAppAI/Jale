import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { recordSignupSource } from '../lib/analytics-capture';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { employerActorFailureResponse, resolveEmployerActor, type EmployerRole } from '../lib/employer-actor';
import { parseSignupSource } from '../lib/signup-source';
import { TRADE_KEYS } from '../lib/worker-vocab';

const CORS_HEADERS = corsHeaders();
// Hiring trades are the full worker main_trade vocabulary, `other` included
// (an employer can hire for a trade outside the five standard ones), so
// this is TRADE_KEYS and not STANDARD_TRADE_KEYS. Aliased rather than
// retyped; the `valid:` array echoed in the 400 body is unchanged.
const VALID_TRADES = TRADE_KEYS;
const VALID_JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
const VALID_COMPANY_SIZES = ['1-10', '11-50', '51-200', '200+'] as const;
// The company's fields are the owner's (Phase 3). A foreman's PATCH writes
// only their own contact name and phone; any other field is refused before
// any write. signup_source is accepted and ignored: a first-profile flush
// from a build that predates invite mode carries it, and a foreman's first
// save must never 403 (it is not a company sign-up, so it is not recorded).
const FOREMAN_PATCH_FIELDS: ReadonlySet<string> = new Set(['contact_name', 'phone', 'signup_source']);

const MEMBERSHIP_SAVEPOINT = 'org_team_membership';
let membershipFallbackLogged = false;

/**
 * The caller's role and the company's name, as every Phase 3 reader shows it
 * (the active owner's company_name, jale_cap.org_team_membership, migration
 * 134): a foreman's own row carries no company fields.
 *
 * Under its own savepoint, because this is the first call on every employer
 * page: before 134 is applied the function is missing (42883), and that must
 * not become an outage. Then the answer comes from the actor and the caller's
 * own row (an owner's row holds the company name; with the flag off every
 * login is an owner), logged once per container. Any other error is rethrown.
 */
async function readMembership(
  client: { query: (sql: string) => Promise<{ rows?: Array<{ role?: string; company_name?: string | null }> }> },
  actorRole: EmployerRole,
  profileRow: { company_name?: string | null },
): Promise<{ role: string; companyName: string | null }> {
  await client.query(`SAVEPOINT ${MEMBERSHIP_SAVEPOINT}`);
  try {
    const membership = await client.query('SELECT role, company_name FROM jale_cap.org_team_membership()');
    await client.query(`RELEASE SAVEPOINT ${MEMBERSHIP_SAVEPOINT}`);
    const row = membership.rows?.[0];
    return { role: row?.role ?? actorRole, companyName: row?.company_name ?? null };
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== '42883') throw err;
    await client.query(`ROLLBACK TO SAVEPOINT ${MEMBERSHIP_SAVEPOINT}`);
    if (!membershipFallbackLogged) {
      membershipFallbackLogged = true;
      console.warn(JSON.stringify({ metric: 'employer_profile_membership_fallback', reason: 'org_team_membership_missing' }));
    }
    return { role: actorRole, companyName: actorRole === 'owner' ? profileRow.company_name ?? null : null };
  }
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function validateStringArray(value: unknown, valid: readonly string[], error: string): string[] | APIGatewayProxyResult {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !valid.includes(item))) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error, valid }) };
  }
  return Array.from(new Set(value));
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires an explicit transaction so SET LOCAL survives until the SELECT
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    // Legal wall: block access if user missing or ToS not accepted
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'user_not_provisioned',
          message: 'Account setup incomplete. Please try signing out and back in.',
        }),
      };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
          currentVersion: compliance.currentVersion,
        }),
      };
    }

    // GET and PATCH both resolve the actor, so a removed member or a login
    // with no organization is answered here, on the first call the app makes.
    const actorResult = await resolveEmployerActor(client, cognitoSub);
    if (!actorResult.ok) {
      await client.query('COMMIT');
      return employerActorFailureResponse(actorResult, CORS_HEADERS);
    }
    const { actor } = actorResult;

    let result;
    if (event.httpMethod === 'PATCH') {
      let body: any;
      try { body = JSON.parse(event.body ?? '{}'); }
      catch {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
      }

      const isOwner = actor.role === 'owner';
      if (!isOwner) {
        const fields = body !== null && typeof body === 'object' ? Object.keys(body) : [];
        if (fields.some((field) => !FOREMAN_PATCH_FIELDS.has(field))) {
          await client.query('COMMIT');
          return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'owner_required' }) };
        }
      }

      const hiringTrades = validateStringArray(body.hiring_trades, VALID_TRADES, 'invalid_hiring_trades');
      if (!Array.isArray(hiringTrades)) {
        await client.query('COMMIT');
        return hiringTrades;
      }
      const typicalJobTypes = validateStringArray(body.typical_job_types, VALID_JOB_TYPES, 'invalid_typical_job_types');
      if (!Array.isArray(typicalJobTypes)) {
        await client.query('COMMIT');
        return typicalJobTypes;
      }
      if (body.company_size !== undefined && body.company_size !== null && !VALID_COMPANY_SIZES.includes(body.company_size)) {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_company_size', valid: VALID_COMPANY_SIZES }) };
      }

      const companyName = cleanText(body.company_name);
      const contactName = cleanText(body.contact_name);
      const phone = cleanText(body.phone);
      const city = cleanText(body.city);
      const serviceArea = cleanText(body.service_area);
      const companySize = cleanText(body.company_size);
      const companyDescription = cleanText(body.company_description);
      const hiringTradesProvided = Object.prototype.hasOwnProperty.call(body, 'hiring_trades');
      const jobTypesProvided = Object.prototype.hasOwnProperty.call(body, 'typical_job_types');

      // The change records name the employer by users.id (the actor), stated
      // before the first write.
      await setAuditContext(client, auditCaller(event, { kind: 'employer', id: actor.userId }, 'web'), 'employer.profile_update');

      // companyName is always null for a foreman (refused above), so a
      // foreman's PATCH never mirrors anything into users.full_name.
      if (companyName) {
        await client.query('UPDATE users SET full_name = $1, phone = COALESCE($2, phone) WHERE cognito_sub = $3', [companyName, phone, cognitoSub]);
      } else if (phone) {
        await client.query('UPDATE users SET phone = $1 WHERE cognito_sub = $2', [phone, cognitoSub]);
      }

      await client.query(
        `INSERT INTO employer_profiles (
           user_id, company_name, contact_name, phone, city, service_area,
           hiring_trades, typical_job_types, company_size, company_description
         )
         VALUES (
           $1,
           $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10
         )
         ON CONFLICT (user_id) DO UPDATE SET
           company_name = COALESCE(EXCLUDED.company_name, employer_profiles.company_name),
           contact_name = COALESCE(EXCLUDED.contact_name, employer_profiles.contact_name),
           phone = COALESCE(EXCLUDED.phone, employer_profiles.phone),
           city = COALESCE(EXCLUDED.city, employer_profiles.city),
           service_area = COALESCE(EXCLUDED.service_area, employer_profiles.service_area),
           hiring_trades = CASE WHEN $11 THEN EXCLUDED.hiring_trades ELSE employer_profiles.hiring_trades END,
           typical_job_types = CASE WHEN $12 THEN EXCLUDED.typical_job_types ELSE employer_profiles.typical_job_types END,
           company_size = COALESCE(EXCLUDED.company_size, employer_profiles.company_size),
           company_description = COALESCE(EXCLUDED.company_description, employer_profiles.company_description),
           updated_at = NOW()
         RETURNING
           user_id,
           company_name,
           contact_name,
           phone,
           city,
           service_area,
           hiring_trades,
           typical_job_types,
           company_size,
           company_description`,
        [
          actor.userId,
          companyName,
          contactName,
          phone,
          city,
          serviceArea,
          hiringTrades,
          typicalJobTypes,
          companySize,
          companyDescription,
          hiringTradesProvided,
          jobTypesProvided,
        ],
      );

      // Where the signup started (contract K3.6), carried by the first save
      // after sign-in. Best-effort under its own savepoint; the function keeps
      // the first write, only for an account created in the last 24 hours,
      // so a later save never changes it.
      const signupSource = isOwner ? parseSignupSource(body.signup_source) : null;
      if (signupSource) {
        await recordSignupSource(client, actor.userId, signupSource);
      }

      result = await client.query(
        `SELECT
           u.id,
           u.user_type,
           u.email,
           COALESCE(ep.phone, u.phone) AS phone,
           u.full_name,
           u.tenant_id,
           u.created_at,
           ep.company_name,
           ep.contact_name,
           ep.city,
           ep.service_area,
           COALESCE(ep.hiring_trades, '{}'::text[]) AS hiring_trades,
           COALESCE(ep.typical_job_types, '{}'::text[]) AS typical_job_types,
           ep.company_size,
           ep.company_description
         FROM users u
         LEFT JOIN employer_profiles ep ON ep.user_id = u.id
         WHERE u.cognito_sub = $1`,
        [cognitoSub],
      );
    } else {
      result = await client.query(
        `SELECT
           u.id,
           u.user_type,
           u.email,
           COALESCE(ep.phone, u.phone) AS phone,
           u.full_name,
           u.tenant_id,
           u.created_at,
           ep.company_name,
           ep.contact_name,
           ep.city,
           ep.service_area,
           COALESCE(ep.hiring_trades, '{}'::text[]) AS hiring_trades,
           COALESCE(ep.typical_job_types, '{}'::text[]) AS typical_job_types,
           ep.company_size,
           ep.company_description
         FROM users u
         LEFT JOIN employer_profiles ep ON ep.user_id = u.id
         WHERE u.cognito_sub = $1`,
        [cognitoSub],
      );
    }
    // Both methods answer with the caller's role and the company's name (the
    // frontend replaces its profile with the PATCH response).
    if (result.rows.length > 0) {
      result.rows[0] = { ...result.rows[0], ...(await readMembership(client, actor.role, result.rows[0])) };
    }
    await client.query('COMMIT');

    if (result.rows.length === 0) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'profile_not_found',
          message: 'Please complete profile setup',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result.rows[0]),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { }
    }
    console.error('Employer profile handler error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error', message: 'Internal server error' }),
    };
  } finally {
    if (client) {
      client.release();
    }
  }
};
