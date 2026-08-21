import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

/**
 * GET   /employer/settings/digest
 * PATCH /employer/settings/digest
 *
 * The employer's own read/write path for employer_digest_settings (migration
 * 080). One Lambda serves both verbs, matching api/employer-profile.ts.
 *
 * PATCH, not PUT: lib/http.ts's corsHeaders() advertises
 * `GET,POST,PATCH,DELETE,OPTIONS` and PUT is absent, so a PUT would fail
 * preflight in the browser regardless of what API Gateway routed.
 *
 * ── Subset semantics ─────────────────────────────────────────────
 * Any subset of the four fields may be sent. Omitted fields are passed as SQL
 * NULL and COALESCEd: against the TABLE DEFAULT on the insert path, and
 * against the EXISTING VALUE on the conflict path. A single statement that
 * coalesced to defaults in both places would silently reset an employer's
 * timezone every time they toggled `enabled`.
 *
 * ── GET never writes ─────────────────────────────────────────────
 * Migration 080's header is explicit that creating a settings row must never
 * by itself start sending mail. GET is therefore a pure SELECT that reports
 * the opt-out defaults (enabled=false) when no row exists; the row is only
 * created by an actual PATCH.
 *
 * ── Timezone validation is two-layered, and the DB owns layer two ─
 * This handler pins only the LEXICAL shape. It deliberately does NOT gate on
 * `Intl.supportedValuesOf('timeZone')`: that list is misaligned with
 * pg_timezone_names in both directions (it omits 'UTC', which PostgreSQL
 * accepts, and includes legacy aliases such as 'Asia/Calcutta'), so using it
 * would both reject valid input and admit values the DB refuses. The
 * authoritative check is migration 080's BEFORE trigger against
 * pg_catalog.pg_timezone_names, which raises 23514 with constraint
 * 'timezone_iana_valid'; that error is mapped back to a 400 here — the same
 * site-local constraint mapping lib/applications.ts:439 does — because without
 * the mapping a merely-wrong timezone would surface as a 500.
 */

const CORS_HEADERS = corsHeaders();

const DEFAULT_SETTINGS = {
  enabled: false,
  send_hour_local: 8,
  timezone: 'America/Chicago',
  language: 'en',
} as const;

const VALID_LANGUAGES = ['en', 'es'] as const;
/** Mirrors employer_digest_settings_timezone_shape's character class. */
const TIMEZONE_SHAPE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const TIMEZONE_MAX_LENGTH = 64;
/** The two 23514 constraints that mean "the caller sent a bad timezone". */
const TIMEZONE_CONSTRAINTS = new Set(['timezone_iana_valid', 'employer_digest_settings_timezone_shape']);

interface DigestSettingsRow {
  enabled: boolean;
  send_hour_local: number;
  timezone: string;
  language: string;
}

interface PatchInput {
  enabled: boolean | null;
  sendHourLocal: number | null;
  timezone: string | null;
  language: string | null;
}

function fail(statusCode: number, error: string, extra: Record<string, unknown> = {}): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ error, ...extra }) };
}

function ok(row: DigestSettingsRow): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      enabled: row.enabled,
      send_hour_local: Number(row.send_hour_local),
      timezone: row.timezone,
      language: row.language,
    }),
  };
}

/** Parses and validates the PATCH body. Returns a 4xx result on rejection. */
function parsePatchBody(rawBody: string | null): PatchInput | APIGatewayProxyResult {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody ?? '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'invalid_json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'invalid_json');

  const result: PatchInput = { enabled: null, sendHourLocal: null, timezone: null, language: null };

  if (body.enabled !== undefined) {
    // Strict boolean — turning digest mail ON is a consent action, so no
    // coercion of "true"/1, same posture as employer-job-public-listing.ts.
    if (typeof body.enabled !== 'boolean') return fail(400, 'invalid_enabled');
    result.enabled = body.enabled;
  }

  if (body.send_hour_local !== undefined) {
    const hour = body.send_hour_local;
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return fail(400, 'invalid_hour');
    }
    result.sendHourLocal = hour;
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string') return fail(400, 'invalid_timezone');
    // Trim before validating AND before storing: the table's shape CHECK
    // requires `timezone = btrim(timezone)`.
    const timezone = body.timezone.trim();
    if (timezone.length === 0 || timezone.length > TIMEZONE_MAX_LENGTH || !TIMEZONE_SHAPE.test(timezone)) {
      return fail(400, 'invalid_timezone');
    }
    result.timezone = timezone;
  }

  if (body.language !== undefined) {
    if (typeof body.language !== 'string' || !VALID_LANGUAGES.includes(body.language as 'en' | 'es')) {
      return fail(400, 'invalid_language');
    }
    result.language = body.language;
  }

  return result;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) return fail(401, 'unauthorized');

    const method = event.httpMethod;
    if (method !== 'GET' && method !== 'PATCH') return fail(405, 'method_not_allowed');

    // Body validation before any connection or transaction: a malformed
    // request never costs a DB round trip.
    let patch: PatchInput | null = null;
    if (method === 'PATCH') {
      const parsed = parsePatchBody(event.body);
      if ('statusCode' in parsed) return parsed;
      patch = parsed;
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('ROLLBACK');
      return fail(409, 'user_not_provisioned');
    }
    if (!compliance.compliant) {
      await client.query('ROLLBACK');
      return fail(403, 'legal_required', {
        requiredVersion: process.env.REQUIRED_TOS_VERSION,
        currentVersion: compliance.currentVersion,
      });
    }

    // FOR UPDATE only on the write path: it serializes two concurrent PATCHes
    // from the same employer (two browser tabs) against one another, which the
    // upsert's ON CONFLICT alone would resolve last-writer-wins per column.
    const employerResult = await client.query<{ id: string }>(
      method === 'PATCH'
        ? 'SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE'
        : 'SELECT id FROM users WHERE cognito_sub = $1',
      [cognitoSub],
    );
    const employerId = employerResult.rows[0]?.id;
    if (!employerId) {
      await client.query('ROLLBACK');
      return fail(409, 'user_not_provisioned');
    }
    await setInternalUserRlsContext(client, employerId);

    if (method === 'GET') {
      const existing = await client.query<DigestSettingsRow>(
        `SELECT enabled, send_hour_local, timezone, language
           FROM employer_digest_settings
          WHERE employer_id = $1`,
        [employerId],
      );
      await client.query('COMMIT');
      return ok(existing.rows[0] ?? { ...DEFAULT_SETTINGS });
    }

    const upserted = await client.query<DigestSettingsRow>(
      `INSERT INTO employer_digest_settings
         (employer_id, enabled, send_hour_local, timezone, language)
       VALUES (
         $1,
         COALESCE($2::boolean, ${DEFAULT_SETTINGS.enabled}),
         COALESCE($3::smallint, ${DEFAULT_SETTINGS.send_hour_local}),
         COALESCE($4::text, '${DEFAULT_SETTINGS.timezone}'),
         COALESCE($5::text, '${DEFAULT_SETTINGS.language}')
       )
       ON CONFLICT (employer_id) DO UPDATE SET
         enabled = COALESCE($2::boolean, employer_digest_settings.enabled),
         send_hour_local = COALESCE($3::smallint, employer_digest_settings.send_hour_local),
         timezone = COALESCE($4::text, employer_digest_settings.timezone),
         language = COALESCE($5::text, employer_digest_settings.language)
       RETURNING enabled, send_hour_local, timezone, language`,
      [employerId, patch!.enabled, patch!.sendHourLocal, patch!.timezone, patch!.language],
    );
    const row = upserted.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return fail(500, 'internal_error');
    }
    await client.query('COMMIT');
    return ok(row);
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch { /* connection already gone */ } }
    const code = (err as { code?: string } | null)?.code;
    const constraint = (err as { constraint?: string } | null)?.constraint;
    if (code === '23514' && constraint && TIMEZONE_CONSTRAINTS.has(constraint)) {
      return fail(400, 'invalid_timezone');
    }
    console.error('employer-digest-settings error:', errorMessage(err));
    return fail(500, 'internal_error');
  } finally {
    if (client) client.release();
  }
};
