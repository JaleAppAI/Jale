import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { filterReusableDefaults } from '../lib/worker-application-defaults';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { recordAccess, recordAttempt, responseFieldNames, type AttemptEvent } from '../lib/audit/record';

// GET /worker/application-defaults -- prefill data for a new application
// (worker_application_defaults, 079_worker_application_defaults.sql).
// Connection/RLS/compliance-gate pattern copied exactly from
// worker-profile.ts (both are simple single-row-per-worker GETs): BEGIN,
// setRlsContext(cognitoSub) so app.current_user_id is set for the
// worker_application_defaults_self RLS policy, checkCompliance gate, the
// worker's id (so the access record's caller exists before the read), then
// one SELECT and its access record, COMMIT.
const CORS_HEADERS = corsHeaders();
const SURFACE = 'worker.application_defaults';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let caller: AuditCaller | undefined;
  let attempt: Omit<AttemptEvent, 'outcome'> | undefined;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    // RLS requires an explicit transaction so SET LOCAL survives until the SELECT
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

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

    // The worker, resolved before the read: a read that fails still leaves a
    // failed attempt, and one that finds nothing still leaves an empty
    // self-read. Keyed on the caller's own sub, like the read.
    const workerResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1`,
      [cognitoSub],
    );
    const workerId = workerResult.rows[0]?.id;
    if (!workerId) {
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
    const purpose = { kind: 'self' } as const;
    caller = auditCaller(event, { kind: 'worker', id: workerId }, 'web');
    attempt = { surface: SURFACE, subjectUserIds: [workerId], purpose };

    // LEFT JOIN, not a plain SELECT FROM worker_application_defaults: a
    // worker who has never saved defaults has no row at all (the table has
    // no default-row-on-signup trigger -- see 079's header), and that must
    // read as `{ answers: {} }`, 200, not a 404. Same shape as
    // worker-profile.ts's `users u LEFT JOIN worker_profiles wp`.
    const result = await client.query<{ worker_id: string; answers: Record<string, unknown> | null; updated_at: string | null }>(
      `SELECT u.id AS worker_id, wad.answers, wad.updated_at
         FROM users u
         LEFT JOIN worker_application_defaults wad ON wad.worker_id = u.id
        WHERE u.cognito_sub = $1`,
      [cognitoSub],
    );

    const row = result.rows[0];
    // REUSE FILTER (sprint 24 L3, decision D2). The web application form
    // prefills its editable draft from this body, so only keys
    // `FIELD_REUSE_POLICY` marks 'stable' may be handed out: a
    // per_application answer (`date_available`, `desired_pay`,
    // `worked_here_before`, `emergency_contact`) was given about ANOTHER
    // job and another employer. The stored row may still hold such keys
    // from before the policy existed -- this door refuses to serve them
    // rather than waiting for a backfill.
    const body = {
      answers: filterReusableDefaults(row?.answers),
      updated_at: row?.updated_at ?? null,
    };
    // The worker reading their own saved answers, recorded before COMMIT;
    // a read that found nothing is recorded too, with a zero count.
    await recordAccess(client, caller, {
      surface: SURFACE,
      subjectUserIds: [workerId],
      resultCount: row?.answers ? 1 : 0,
      fieldNames: responseFieldNames(body),
      purpose,
    });
    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(body),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (caller && attempt) await recordAttempt(client, caller, { ...attempt, outcome: 'failed' });
    }
    console.error('worker-application-defaults-get error:', errorMessage(err));
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
