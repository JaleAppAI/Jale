import type { PoolClient } from 'pg';
import { isTwilioMessageSid, type TwilioSecret } from './twilio';
import {
  getTwilioSecret,
  requireTwilioStatusCallbackUrl,
  _clearTwilioSecretCacheForTests,
} from './twilio-secret';
import type { RenderedOutboxMessage } from './onboarding-types';

const FALLBACK_BODY_KEY = '__fallback_body';

// H3: poison-message guard for the scheduled admin dispatcher. A row that Twilio
// hard-rejects (4xx) flips to 'failed' and would otherwise be re-selected and
// re-sent every minute forever. Stop retrying after this many attempts; the row
// stays 'failed' with last_error set for operator follow-up.
const MAX_ADMIN_SEND_ATTEMPTS = 5;

class AmbiguousTwilioSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTwilioSendError';
  }
}

export { AmbiguousTwilioSendError };

export async function sendTwilioWhatsAppMessage(to: string, row: {
  body: string | null;
  content_template: string | null;
  content_variables: Record<string, string> | null;
}): Promise<string | null> {
  const secret = await getTwilioSecret();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${secret.accountSid}/Messages.json`;
  const formValues: Record<string, string> = {
    MessagingServiceSid: secret.messagingServiceSid,
    To: to,
    StatusCallback: requireTwilioStatusCallbackUrl(),
  };

  if (row.content_template) {
    const contentSid = secret.templates?.[row.content_template as keyof NonNullable<TwilioSecret['templates']>];
    if (!contentSid) {
      if (row.content_template.startsWith('employer_message_')) {
        throw new Error(`Twilio template missing: ${row.content_template}`);
      }
      const fallbackBody = row.content_variables?.[FALLBACK_BODY_KEY];
      if (!fallbackBody) {
        throw new Error(`Twilio template missing: ${row.content_template}`);
      }
      formValues.Body = fallbackBody;
    } else {
      const { [FALLBACK_BODY_KEY]: _fallback, ...contentVariables } = row.content_variables ?? {};
      formValues.ContentSid = contentSid;
      formValues.ContentVariables = JSON.stringify(contentVariables);
    }
  } else {
    formValues.Body = row.body ?? '';
  }

  const form = new URLSearchParams(formValues);
  const auth = Buffer.from(`${secret.accountSid}:${secret.authToken}`).toString('base64');
  const timeoutMs = parseTimeout(process.env.TWILIO_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new AmbiguousTwilioSendError(
        `Twilio request timed out after ${timeoutMs}ms; delivery state unknown`,
      );
    }
    // Once fetch starts, a transport failure cannot prove Twilio rejected the
    // POST. The peer may have accepted it before the connection reset or the
    // response was truncated. Never automatically resend in that state.
    const reason = error instanceof Error ? error.message : String(error);
    throw new AmbiguousTwilioSendError(
      `Twilio transport failed; delivery state unknown: ${reason}`,
    );
  }
  if (!res.ok) {
    throw new Error(`Twilio send failed with HTTP ${res.status}`);
  }
  let responseBody: { sid?: string } | null = null;
  try {
    responseBody = await res.json() as { sid?: string };
  } catch {
    // A 2xx with an unparseable body means we cannot confirm what Twilio did
    // with the message — ambiguous, not success.
    throw new AmbiguousTwilioSendError('Twilio 2xx response body was not valid JSON');
  }
  const sid = responseBody?.sid;
  if (!isTwilioMessageSid(sid)) {
    // A 2xx HTTP status only means Twilio accepted the request over the
    // wire — it does not guarantee a valid message SID came back. Treat a
    // missing or malformed SID as ambiguous (never as success): the caller
    // must not mark the row 'sent' without a real SM.../MM... SID to correlate
    // delivery-status callbacks against.
    throw new AmbiguousTwilioSendError(
      `Twilio response missing a valid message SID (got: ${JSON.stringify(sid)})`,
    );
  }
  return sid;
}

/**
 * Drain pending outbox rows to Twilio. Call only after the DB transaction
 * that created those rows has committed.
 */
export async function sendPendingOutbox(
  client: PoolClient,
  inboundMessageSid: string,
): Promise<void> {
  const pending = await client.query<{
    id: string;
    sequence: number;
    whatsapp_number: string;
    body: string | null;
    content_template: string | null;
    content_variables: Record<string, string> | null;
  }>(
    `SELECT id, sequence, whatsapp_number, body, content_template, content_variables
       FROM whatsapp_outbox
      WHERE inbound_message_sid = $1
        AND status IN ('pending', 'failed')
      ORDER BY sequence`,
    [inboundMessageSid],
  );

  for (const row of pending.rows) {
    try {
      const twilioMessageSid = await sendTwilioWhatsAppMessage(`whatsapp:${row.whatsapp_number}`, row);
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'sent',
                sent_at = now(),
                twilio_message_sid = COALESCE($2, twilio_message_sid)
          WHERE id = $1`,
        [row.id, twilioMessageSid],
      );
    } catch (err) {
      const ambiguous = err instanceof AmbiguousTwilioSendError;
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = $1,
                attempt_count = attempt_count + 1,
                last_error = $2
          WHERE id = $3`,
        [ambiguous ? 'send_unknown' : 'failed', (err as Error).message, row.id],
      );
      throw err;
    }
  }
}

export async function queueOutboxText(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  body: string,
): Promise<void> {
  const whatsappNumber = to.replace(/^whatsapp:/, '');
  // Computing the next sequence in-SQL is race-free within the enclosing
  // transaction — all queue writes for one inbound SID happen in one tx.
  await client.query(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, body)
     VALUES (
       $1::varchar,
       (SELECT COALESCE(MAX(sequence), 0) + 1
          FROM whatsapp_outbox
         WHERE inbound_message_sid = $1::varchar),
       $2, $3
     )`,
    [inboundMessageSid, whatsappNumber, body],
  );
}

// ── Job-alert outbox: idempotent producer + crash-safe scheduled drain ──
//
// The producer (job-alert.ts) only claims a durable, idempotent outbox row
// per (job, worker) — it never sends to Twilio inline. All sending happens
// in drainJobAlertOutbox(), invoked on a 5-minute EventBridge schedule
// (JobAlertOutboxDrainLambda). This removes the crash window that existed
// when the producer inserted a pending row and sent directly in the same
// invocation: a Lambda timeout or crash between "insert" and "mark sent"
// could strand a 'pending' row forever, or (worse) a retry of the whole
// invocation could re-send a message Twilio already accepted.
const MAX_JOB_ALERT_ATTEMPTS = 5;
const JOB_ALERT_BACKOFF_BASE_MS = 30_000; // 30s, doubled per attempt
const JOB_ALERT_BACKOFF_CAP_MS = 30 * 60_000; // 30 min ceiling

export interface JobAlertQueueRow {
  whatsappNumber: string;
  templateKey: string;
  variables: Record<string, string>;
  jobId: string;
  workerId: string;
}

/**
 * Idempotently claim/refresh a job_alert outbox row. Safe to call
 * repeatedly for the same (jobId, workerId) pair: the unique
 * `job-alert:<jobId>:<workerId>` idempotency key means a second call while
 * the first is still pending/sent is a no-op, and a second call after a
 * terminal 'failed' row (under the attempt cap) re-queues it. Returns the
 * queued row id, or undefined if nothing needed to change (already
 * pending/sent, or failed at the attempt cap).
 */
export async function queueJobAlert(
  client: PoolClient,
  row: JobAlertQueueRow,
): Promise<string | undefined> {
  const claimed = await client.query<{ id: string }>(
    `INSERT INTO whatsapp_outbox
       (inbound_message_sid, sequence, whatsapp_number, body,
        content_template, content_variables, source_type, source_id,
        idempotency_key)
     VALUES (NULL, 1, $1, NULL, $2, $3::jsonb, 'job_alert', $4, $5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET status = 'pending', next_attempt_at = NULL
       WHERE whatsapp_outbox.status = 'failed'
         AND whatsapp_outbox.attempt_count < ${MAX_JOB_ALERT_ATTEMPTS}
     RETURNING id`,
    [row.whatsappNumber, row.templateKey, JSON.stringify(row.variables), row.jobId,
      `job-alert:${row.jobId}:${row.workerId}`],
  );
  return claimed.rows[0]?.id;
}

interface ClaimedJobAlertRow {
  id: string;
  whatsapp_number: string;
  body: string | null;
  content_template: string | null;
  content_variables: Record<string, string> | null;
  attempt_count: number;
}

/**
 * Scheduled drain for job_alert outbox rows (EventBridge, every 5 minutes).
 * Crash-safe claim-then-send:
 *
 *   1. SKIP LOCKED claim of one due row, committed as 'send_unknown' with
 *      attempt_count incremented BEFORE any network call. If the process
 *      dies right here, the row is already ambiguous (never silently
 *      re-queued as fresh 'pending', never left claimable by a concurrent
 *      drain) and will not be retried automatically. An operator can
 *      reconcile the ambiguous send using Twilio's message records.
 *   2. The Twilio send happens outside that transaction, on a separate
 *      pool connection.
 *   3. Success requires a syntactically valid `SM...`/`MM...` SID
 *      (sendTwilioWhatsAppMessage already enforces this) — that is the
 *      only path back to 'sent'.
 *   4. AmbiguousTwilioSendError (timeout / malformed response) leaves the
 *      row terminally 'send_unknown'. Retrying an ambiguous send can create
 *      a duplicate if Twilio accepted the first request before the timeout.
 *   5. Any other error is treated as definite non-acceptance: bounded
 *      retry with backoff back to 'pending' under the attempt cap, else
 *      terminal 'failed'.
 */
export async function drainJobAlertOutbox(
  pool: { connect(): Promise<PoolClient> },
  limit = 25,
): Promise<{ sent: number; ambiguous: number; failed: number }> {
  let sent = 0;
  let ambiguous = 0;
  let failed = 0;

  for (let processed = 0; processed < limit; processed += 1) {
    const claimClient = await pool.connect();
    let claimedRow: ClaimedJobAlertRow | undefined;
    try {
      await claimClient.query('BEGIN');
      const result = await claimClient.query<ClaimedJobAlertRow>(
        `SELECT id, whatsapp_number, body, content_template, content_variables, attempt_count
           FROM whatsapp_outbox
          WHERE source_type = 'job_alert'
            AND status = 'pending'
            AND attempt_count < $1
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [MAX_JOB_ALERT_ATTEMPTS],
      );
      claimedRow = result.rows[0];
      if (claimedRow) {
        await claimClient.query(
          `UPDATE whatsapp_outbox
              SET status = 'send_unknown', attempt_count = attempt_count + 1,
                  next_attempt_at = NULL
            WHERE id = $1`,
          [claimedRow.id],
        );
      }
      await claimClient.query('COMMIT');
    } catch (err) {
      await claimClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      claimClient.release();
    }

    if (!claimedRow) break; // nothing due; stop polling this invocation

    const attemptCount = claimedRow.attempt_count + 1; // already bumped above
    try {
      const sid = await sendTwilioWhatsAppMessage(`whatsapp:${claimedRow.whatsapp_number}`, claimedRow);
      const resultClient = await pool.connect();
      try {
        await resultClient.query(
          `UPDATE whatsapp_outbox
              SET status = 'sent', sent_at = now(), twilio_message_sid = $2,
                  last_error = NULL, next_attempt_at = NULL
            WHERE id = $1`,
          [claimedRow.id, sid],
        );
      } finally {
        resultClient.release();
      }
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAmbiguous = err instanceof AmbiguousTwilioSendError;
      const atCap = attemptCount >= MAX_JOB_ALERT_ATTEMPTS;
      const backoffMs = Math.min(
        JOB_ALERT_BACKOFF_BASE_MS * 2 ** Math.max(attemptCount - 1, 0),
        JOB_ALERT_BACKOFF_CAP_MS,
      );
      const resultClient = await pool.connect();
      try {
        if (isAmbiguous) {
          await resultClient.query(
            `UPDATE whatsapp_outbox
                SET status = 'send_unknown', last_error = $2,
                    next_attempt_at = NULL
              WHERE id = $1`,
            [claimedRow.id, message],
          );
        } else if (atCap) {
          await resultClient.query(
            `UPDATE whatsapp_outbox SET status = 'failed', last_error = $2 WHERE id = $1`,
            [claimedRow.id, message],
          );
        } else {
          await resultClient.query(
            `UPDATE whatsapp_outbox
                SET status = 'pending', last_error = $2,
                    next_attempt_at = now() + ($3 || ' milliseconds')::interval
              WHERE id = $1`,
            [claimedRow.id, message, String(backoffMs)],
          );
        }
      } finally {
        resultClient.release();
      }
      if (isAmbiguous) ambiguous++;
      else failed++;
    }
  }

  return { sent, ambiguous, failed };
}

export async function sendPendingAdminOutbox(
  client: PoolClient,
  limit = 25,
): Promise<void> {
  for (let processed = 0; processed < limit; processed += 1) {
    await client.query('BEGIN');
    try {
      const pending = await client.query<{
        id: string;
        sequence: number;
        whatsapp_number: string;
        body: string | null;
        content_template: string | null;
        content_variables: Record<string, string> | null;
      }>(
        `SELECT id, sequence, whatsapp_number, body, content_template, content_variables
           FROM whatsapp_outbox
          WHERE source_type = 'admin_case'
            AND status IN ('pending', 'failed')
            AND attempt_count < $1
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [MAX_ADMIN_SEND_ATTEMPTS],
      );

      const row = pending.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return;
      }

      try {
        const twilioMessageSid = await sendTwilioWhatsAppMessage(`whatsapp:${row.whatsapp_number}`, row);
        await client.query(
          `UPDATE whatsapp_outbox
              SET status = 'sent',
                  sent_at = now(),
                  twilio_message_sid = COALESCE($2, twilio_message_sid),
                  last_error = NULL
            WHERE id = $1`,
          [row.id, twilioMessageSid],
        );
        await client.query(
          `SELECT record_admin_whatsapp_delivery($1, 'sent', $2, NULL)`,
          [row.id, twilioMessageSid],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ambiguous = err instanceof AmbiguousTwilioSendError;
        const failureStatus = ambiguous ? 'send_unknown' : 'failed';
        // H4: parameterize the status instead of interpolating it into the SQL
        // string. Matches sendPendingOutbox() above and the repo's rule against
        // string-built SQL predicates.
        await client.query(
          `UPDATE whatsapp_outbox
              SET status = $1,
                  attempt_count = attempt_count + 1,
                  last_error = $2
            WHERE id = $3`,
          [failureStatus, message, row.id],
        );
        await client.query(
          `SELECT record_admin_whatsapp_delivery($1, $2, NULL, $3)`,
          [row.id, failureStatus, message],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
}

function parseTimeout(raw: string | undefined): number {
  const value = Number(raw ?? 4000);
  if (!Number.isInteger(value) || value < 500 || value > 10000) {
    throw new Error('TWILIO_REQUEST_TIMEOUT_MS must be between 500 and 10000');
  }
  return value;
}

export function _clearOutboxTwilioSecretCacheForTests(): void {
  _clearTwilioSecretCacheForTests();
}

/**
 * Inserts a `whatsapp_outbox` row on behalf of a `worker_message_intents`
 * row that the delivery-policy gate has already authorized (status
 * 'eligible' or 'leased'). This is the only path that may write a
 * `source_type = 'worker_intent'` outbox row — the `whatsapp_outbox_origin_check`
 * CHECK constraint requires `inbound_message_sid IS NULL` and a non-null
 * `source_id` for that origin, matching the params below.
 *
 * Ownership/errors: caller owns the transaction; no BEGIN/COMMIT here.
 * Throws `Error('unauthorized_worker_outbox_row')` when the intent row is
 * missing or not in an authorized status — this is a deliberate guard
 * against writing an outbox row for a deferred/rejected/expired intent.
 */
export async function insertAuthorizedIntentOutbox(
  client: PoolClient,
  intentId: string,
  message: RenderedOutboxMessage,
): Promise<{ outboxId: string }> {
  const statusResult = await client.query<{ status: string }>(
    `SELECT status FROM worker_message_intents WHERE id = $1`,
    [intentId],
  );
  const status = statusResult.rows[0]?.status;
  if (status !== 'eligible' && status !== 'leased') {
    throw new Error('unauthorized_worker_outbox_row');
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables, source_type, source_id)
     VALUES (NULL, 1, $1, $2, $3, $4::jsonb, 'worker_intent', $5)
     RETURNING id`,
    [
      message.whatsappNumber,
      message.body,
      message.contentTemplate,
      message.contentVariables ? JSON.stringify(message.contentVariables) : null,
      intentId,
    ],
  );
  return { outboxId: inserted.rows[0].id };
}
