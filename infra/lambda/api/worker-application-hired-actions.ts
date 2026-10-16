/**
 * The hired worker's two web actions -- F19 (sprint 28, contracts K4.3 and
 * K4.4):
 *
 *   POST /worker/applications/{applicationId}/message           -> 201
 *   POST /worker/applications/{applicationId}/remind-employer   -> 202
 *
 * Not a Lambda entry of its own: `worker-application-details.ts` owns the
 * `{applicationId}/{action}` door and forwards these two actions here before
 * it opens its transaction, so they cost no new route or function and run on
 * the same WhatsApp login, resolving the caller the same way.
 *
 * ── THE MESSAGE IS A DEFINER ───────────────────────────────────────
 * `jale_cap.worker_post_application_message` (migration 125) checks that the
 * application is the caller's and hired, holds the 10-an-hour limit, opens
 * the conversation when none is open and adds one inbound worker message,
 * which is what raises the employer's unread badge. It moves
 * `last_message_at` only: `last_worker_message_at` is the WhatsApp reply
 * window, and a web message opens none, so the employer's reply still goes
 * out as the template outside it.
 *
 * ── THE REMINDER IS A STAMP ────────────────────────────────────────
 * The remind button stamps `hire_details_reminded_at` (125 grants the
 * WhatsApp login that one column), at most once per 24 hours per
 * application, and only while the employer has given no details. The
 * digest producer's next sweep claims the stamp and emails the employer, so
 * the answer is 202. A reminder when details already exist is a 202 that
 * stamps nothing: there is nothing left to ask for.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool, setInternalUserRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeMessageBody } from '../lib/job-messaging';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A 2000-character message and its JSON wrapper fit with room to spare. */
const MAX_BODY_BYTES = 16 * 1024;
const REMIND_INTERVAL_SECONDS = 24 * 60 * 60;

export const MESSAGE_ACTION = 'message';
export const REMIND_ACTION = 'remind-employer';

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

type Entry =
  | { ok: true; applicationId: string; cognitoSub: string }
  | { ok: false; response: APIGatewayProxyResult };

/** Checks that need no database: caller, id, method. */
function preflight(event: APIGatewayProxyEvent): Entry {
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (typeof cognitoSub !== 'string' || cognitoSub.trim() === '') return { ok: false, response: json(401, { error: 'unauthorized' }) };
  const applicationId = event.pathParameters?.applicationId;
  if (typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId)) {
    return { ok: false, response: json(404, { error: 'not_found' }) };
  }
  if ((event.httpMethod ?? '').toUpperCase() !== 'POST') return { ok: false, response: json(405, { error: 'method_not_allowed' }) };
  return { ok: true, applicationId, cognitoSub };
}

/**
 * The details door's entry sequence: BEGIN, the worker behind the token
 * (086's resolver), the caller context the definers and policies read, and
 * the terms wall. Answers a refusal (after ROLLBACK) or the worker id.
 */
async function enter(client: PoolClient, cognitoSub: string): Promise<{ workerId: string } | { response: APIGatewayProxyResult }> {
  await client.query('BEGIN');
  const resolved = await client.query<{ id: string | null }>(`SELECT public.resolve_worker_internal_id($1) AS id`, [cognitoSub]);
  const workerId = resolved.rows[0]?.id ?? null;
  if (!workerId) {
    await client.query('ROLLBACK');
    return { response: json(404, { error: 'worker_not_found' }) };
  }
  await setInternalUserRlsContext(client, workerId);
  const required = process.env.REQUIRED_TOS_VERSION ?? '1.0';
  const tos = await client.query<{ tos_version: string | null }>(`SELECT tos_version FROM users WHERE id = $1`, [workerId]);
  const current = tos.rows[0]?.tos_version ?? null;
  if (current?.trim() !== required.trim()) {
    await client.query('ROLLBACK');
    return { response: json(403, { error: 'legal_required', requiredVersion: required, currentVersion: current }) };
  }
  return { workerId };
}

async function withClient(
  metric: string,
  run: (client: PoolClient) => Promise<APIGatewayProxyResult>,
): Promise<APIGatewayProxyResult> {
  let client: PoolClient | undefined;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    return await run(client);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    console.error(JSON.stringify({ metric, error: errorMessage(err) }));
    return json(500, { error: 'internal_error' });
  } finally {
    client?.release();
  }
}

/** `POST {applicationId}/message` (K4.3). */
export async function messageHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const entry = preflight(event);
  if (!entry.ok) return entry.response;
  if (event.body && Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) return json(400, { error: 'invalid_message' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid_message' });
  }
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? normalizeMessageBody((parsed as Record<string, unknown>).body)
    : null;
  // A NUL is legal JSON and refused by Postgres text: a 400 here, not a 500 there.
  if (body === null || body.includes('\u0000')) return json(400, { error: 'invalid_message' });

  return withClient('WorkerApplicationMessageFailed', async (client) => {
    const entered = await enter(client, entry.cognitoSub);
    if ('response' in entered) return entered.response;

    const res = await client.query<{
      outcome: string; conversation_id: string | null; message_id: string | null;
      sent_at: Date | string | null; retry_after_seconds: number | null;
    }>(
      `SELECT outcome, conversation_id, message_id, sent_at, retry_after_seconds
         FROM jale_cap.worker_post_application_message($1, $2)`,
      [entry.applicationId, body],
    );
    const row = res.rows[0];
    switch (row?.outcome) {
      case 'sent': {
        await client.query('COMMIT');
        const sentAt = row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at;
        return json(201, { conversation_id: row.conversation_id, message_id: row.message_id, sent_at: sentAt });
      }
      case 'rate_limited':
        await client.query('ROLLBACK');
        return json(429, { error: 'rate_limited', retry_after_seconds: row.retry_after_seconds ?? 3600 });
      case 'not_hired':
        await client.query('ROLLBACK');
        return json(409, { error: 'not_hired' });
      case 'invalid':
        await client.query('ROLLBACK');
        return json(400, { error: 'invalid_message' });
      default:
        await client.query('ROLLBACK');
        return json(404, { error: 'not_found' });
    }
  });
}

/** `POST {applicationId}/remind-employer` (K4.4). */
export async function remindHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const entry = preflight(event);
  if (!entry.ok) return entry.response;

  return withClient('WorkerApplicationRemindFailed', async (client) => {
    const entered = await enter(client, entry.cognitoSub);
    if ('response' in entered) return entered.response;

    // One conditional statement, so two taps cannot both stamp.
    const stamped = await client.query(
      `UPDATE job_applications
          SET hire_details_reminded_at = now()
        WHERE id = $1 AND worker_id = $2 AND status = 'hired'
          AND hire_start_date IS NULL AND hire_report_location IS NULL AND hire_contact_name IS NULL
          AND hire_contact_phone IS NULL AND hire_notes IS NULL
          AND (hire_details_reminded_at IS NULL OR hire_details_reminded_at <= now() - interval '24 hours')
        RETURNING id`,
      [entry.applicationId, entered.workerId],
    );
    if ((stamped.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return json(202, {});
    }

    // Nothing stamped: say why.
    const res = await client.query<{ status: string; has_details: boolean; retry_after_seconds: number | null }>(
      `SELECT status,
              (hire_start_date IS NOT NULL OR hire_report_location IS NOT NULL OR hire_contact_name IS NOT NULL
               OR hire_contact_phone IS NOT NULL OR hire_notes IS NOT NULL) AS has_details,
              CEIL(EXTRACT(EPOCH FROM hire_details_reminded_at + interval '24 hours' - now()))::int AS retry_after_seconds
         FROM job_applications
        WHERE id = $1 AND worker_id = $2`,
      [entry.applicationId, entered.workerId],
    );
    await client.query('ROLLBACK');
    const row = res.rows[0];
    if (!row) return json(404, { error: 'not_found' });
    if (row.status !== 'hired') return json(409, { error: 'not_hired' });
    if (row.has_details) return json(202, {});
    const retry = Math.min(REMIND_INTERVAL_SECONDS, Math.max(1, row.retry_after_seconds ?? REMIND_INTERVAL_SECONDS));
    return json(429, { error: 'rate_limited', retry_after_seconds: retry });
  });
}

