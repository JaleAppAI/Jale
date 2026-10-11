import type { PoolClient } from 'pg';
import { isTwilioMessageSid, type TwilioSecret } from './twilio';
import {
  getTwilioSecret,
  requireTwilioStatusCallbackUrl,
  _clearTwilioSecretCacheForTests,
} from './twilio-secret';
import type { RenderedOutboxMessage } from './onboarding-types';

/**
 * The content-variable key that carries a plain-text fallback body.
 * `sendTwilioWhatsAppMessage` strips it before sending ContentVariables and
 * falls back to its value as a plain `Body` when the content template has no
 * ContentSid seeded in the Twilio secret yet.
 *
 * EXPORTED (sprint 23) so `lib/application-stage-notify.ts` -- which used to
 * mirror the literal with a FOLLOW-UP note -- can import it instead of
 * duplicating it.
 */
export const FALLBACK_BODY_KEY = '__fallback_body';

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

/**
 * Twilio rejected the send because the ContentSid is invalid or not usable
 * (error 21655) — an unapproved, deleted, or mistyped template SID in the
 * jale/whatsapp/twilio secret. Retrying cannot succeed until the secret or
 * the template's WhatsApp approval changes; surfaced as its own metric so
 * the failure is one CloudWatch query away instead of invisible.
 */
export class TwilioTemplateInvalidError extends Error {
  constructor(
    public readonly templateName: string,
    public readonly twilioCode: number,
  ) {
    super(`Twilio template invalid (code ${twilioCode}): ${templateName}`);
    this.name = 'TwilioTemplateInvalidError';
  }
}

/**
 * Twilio answered a send with a 4xx/5xx that is not one of the classes above.
 *
 * Deliberately carries the SAME message the plain `Error` used to carry, so
 * every existing caller that only stringifies `.message` (and the persisted
 * `last_error` text an operator reads) is unchanged. The addition is
 * `twilioCode`: the drain has to distinguish one specific rejection from the
 * rest, and re-parsing it back out of the message text would be a regex over
 * a human-readable string.
 */
export class TwilioSendRejectedError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly twilioCode: number | null,
  ) {
    super(
      `Twilio send failed with HTTP ${httpStatus}`
      + `${twilioCode !== null ? ` (code ${twilioCode})` : ''}`,
    );
    this.name = 'TwilioSendRejectedError';
  }
}

/**
 * "Message failed to send because the recipient has not initiated a
 * conversation in the last 24 hours" -- Meta's rule that a freeform (non
 * template) WhatsApp message may only be sent inside an open session window.
 */
export const TWILIO_OUTSIDE_SESSION_WINDOW_CODE = 63016;

/**
 * The employer-triggered application-stage lane (`application_update_*`,
 * `application_hired_*`). A 63016 HERE means one specific thing: the Content
 * template Meta has not approved yet, so the sender fell back to a freeform
 * body that Meta will refuse for as long as the approval is pending.
 */
const APPLICATION_TEMPLATE_PREFIX = 'application_';

/**
 * How long to park such a row, and the reason written to `last_error`. One
 * hour, because the thing being waited on is a human Meta review, not a
 * transient network condition -- 043's 30s..30min backoff is the wrong shape
 * and would burn the whole attempt budget inside an hour.
 */
const TEMPLATE_PENDING_DEFER_SECONDS = 3600;
const TEMPLATE_PENDING_DEFER_REASON = 'twilio_63016_template_pending';

/**
 * True when a send failure is "the template is not approved yet" rather than
 * "this send failed". The template-name test is not cosmetic: outside the
 * application lane a 63016 means a session window that really did lapse for a
 * lane whose template IS approved, and parking those for 48 hours would hide
 * real failures.
 */
function isTemplatePendingRejection(
  error: unknown,
  contentTemplate: string | null,
): boolean {
  return error instanceof TwilioSendRejectedError
    && error.twilioCode === TWILIO_OUTSIDE_SESSION_WINDOW_CODE
    && typeof contentTemplate === 'string'
    && contentTemplate.startsWith(APPLICATION_TEMPLATE_PREFIX);
}

export async function sendTwilioWhatsAppMessage(to: string, row: {
  body: string | null;
  content_template: string | null;
  content_variables: Record<string, string> | null;
}): Promise<string> {
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
    let twilioCode: number | null = null;
    try {
      const errorBody = await res.json() as { code?: number };
      twilioCode = typeof errorBody?.code === 'number' ? errorBody.code : null;
    } catch {
      // Non-JSON error body: fall through to the generic error.
    }
    if (twilioCode === 21655 && row.content_template) {
      throw new TwilioTemplateInvalidError(row.content_template, twilioCode);
    }
    throw new TwilioSendRejectedError(res.status, twilioCode);
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
      // 2026-07-27 observability pass: this module previously logged
      // nothing — a Twilio rejection was visible only in the DB row. Safe
      // scalars only: never the body or the phone number.
      console.error(JSON.stringify({
        metric: 'OutboxSendFailure',
        outboxId: row.id,
        status: ambiguous ? 'send_unknown' : 'failed',
        contentTemplate: row.content_template ?? null,
      }));
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

interface LeasedWorkerIntentOutboxRow {
  id: string;
  whatsapp_number: string;
  body: string | null;
  content_template: string | null;
  content_variables: Record<string, string> | null;
  attempt_count: number;
  lease_token: string;
}

/**
 * Sends rows claimed by migration 043's SECURITY DEFINER RPC. The database
 * owns ordering, retry/backoff, and fencing; network I/O starts only after
 * the claim call has committed.
 *
 * A leased row has FIVE ends, not three. `deferred` is migration 093's
 * addition: the row is rescheduled without spending an attempt, because the
 * failure was "Meta has not approved this template yet" and no number of
 * retries changes that. It is counted separately from `failed` on purpose --
 * one needs an operator to chase a template approval, the other needs a code
 * or provider fix, and rolling them together made the 2026-09-04 incident
 * look like an ordinary send failure.
 *
 * `expired` is the other half of that outcome, and it is a DEATH. 093's
 * 48-hour ceiling lives inside the RPC's own UPDATE (`created_at < now() -
 * interval '48 hours'` -> status = 'failed'), and the function returns a bare
 * BOOLEAN either way -- so "parked for another hour" and "given up on
 * forever" are the same `true` to this caller. Counting both as `deferred`
 * meant an employer's "we want to hire you" could age out with `failed` still
 * 0, no WorkerIntentOutboxFailure line, and nothing whatsoever in CloudWatch.
 * `recordDeferral` therefore reads the row's status back and reports which
 * branch the definer actually took.
 */
export async function drainWorkerIntentOutbox(
  pool: { connect(): Promise<PoolClient> },
  limit = 10,
): Promise<{
  sent: number; ambiguous: number; failed: number; leaseLost: number;
  deferred: number; expired: number;
}> {
  const leaseClient = await pool.connect();
  let leased: LeasedWorkerIntentOutboxRow[];
  try {
    const result = await leaseClient.query<LeasedWorkerIntentOutboxRow>(
      'SELECT * FROM lease_worker_intent_outbox($1)', [limit],
    );
    leased = result.rows;
  } finally {
    leaseClient.release();
  }

  let sent = 0;
  let ambiguous = 0;
  let failed = 0;
  let leaseLost = 0;
  let deferred = 0;
  let expired = 0;

  const recordFailure = async (
    row: LeasedWorkerIntentOutboxRow,
    error: unknown,
    isAmbiguous: boolean,
  ): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    const resultClient = await pool.connect();
    try {
      const failure = await resultClient.query<{ failed: boolean }>(
        'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
        [row.id, row.lease_token, message, isAmbiguous],
      );
      if (failure.rows[0]?.failed !== true) {
        leaseLost += 1;
        throw new Error(`worker_intent_lease_lost:${row.id}`);
      }
    } finally {
      resultClient.release();
    }
  };

  /**
   * Migration 093's third outcome. A sibling of `recordFailure` rather than a
   * flag on it: the RPCs differ in name, arity and meaning, and the one thing
   * they must share -- treating a `false` return as a lost lease rather than
   * as a quiet no-op -- is repeated here deliberately.
   *
   * Returns WHICH of 093's two branches ran, which the RPC itself will not
   * say: `RETURNS BOOLEAN`, and it is `true` both for the row that went back
   * to 'pending' and for the row the 48-hour ceiling just moved to 'failed'.
   * So the status is read back -- on the SAME client, inside the same
   * connect/release, and projected to `status` alone rather than `SELECT *`
   * on a row that carries a phone number and a message body. 093 is applied
   * and frozen; this is how its terminal branch becomes observable without
   * touching it.
   */
  const recordDeferral = async (
    row: LeasedWorkerIntentOutboxRow,
  ): Promise<'deferred' | 'expired'> => {
    const resultClient = await pool.connect();
    try {
      const deferral = await resultClient.query<{ deferred: boolean }>(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [row.id, row.lease_token, TEMPLATE_PENDING_DEFER_REASON,
          TEMPLATE_PENDING_DEFER_SECONDS],
      );
      if (deferral.rows[0]?.deferred !== true) {
        leaseLost += 1;
        throw new Error(`worker_intent_lease_lost:${row.id}`);
      }
      const after = await resultClient.query<{ status: string }>(
        "SELECT status FROM whatsapp_outbox WHERE id = $1 AND source_type = 'worker_intent'",
        [row.id],
      );
      // No row (or any status other than 'failed') is NOT evidence of the
      // terminal branch: 043's sweep or an operator could have moved the row
      // between the two statements, and calling that an expiry would page
      // someone about a Meta approval that had nothing to do with it. Only an
      // explicit 'failed' is read as the ceiling having fired.
      return after.rows[0]?.status === 'failed' ? 'expired' : 'deferred';
    } finally {
      resultClient.release();
    }
  };

  for (const row of leased) {
    let sid: string;
    try {
      sid = await sendTwilioWhatsAppMessage(`whatsapp:${row.whatsapp_number}`, row);
    } catch (error) {
      // Order matters. An ambiguous failure (a timeout, a torn connection)
      // carries no Twilio code and leaves the delivery state UNKNOWN, so it
      // is decided first and can never be rescheduled by the branch below --
      // not even when the template name matches.
      const isAmbiguous = error instanceof AmbiguousTwilioSendError;
      if (!isAmbiguous && isTemplatePendingRejection(error, row.content_template)) {
        const outcome = await recordDeferral(row);
        // No count on either line: one is emitted per row, and the metric
        // filters that count them (WorkerIntentTemplatePendingMetric /
        // WorkerIntentTemplateExpiredMetric in whatsapp-stack.ts, both on this
        // Lambda's log group) publish a fixed value of 1 per occurrence.
        //
        // Mutually exclusive on purpose. A row that just died emitting the
        // pending line too would inflate the "waiting on Meta" metric with
        // deaths and leave the two alarms saying the same thing.
        if (outcome === 'expired') {
          console.log(JSON.stringify({ metric: 'WorkerIntentOutboxTemplateExpired' }));
          expired += 1;
        } else {
          console.log(JSON.stringify({ metric: 'WorkerIntentOutboxTemplatePending' }));
          deferred += 1;
        }
        continue;
      }
      await recordFailure(row, error, isAmbiguous);
      if (isAmbiguous) ambiguous += 1;
      else failed += 1;
      continue;
    }

    try {
      const resultClient = await pool.connect();
      try {
        const completion = await resultClient.query<{ completed: boolean }>(
          'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
          [row.id, row.lease_token, sid],
        );
        if (completion.rows[0]?.completed !== true) {
          leaseLost += 1;
          throw new Error(`worker_intent_lease_lost:${row.id}`);
        }
      } finally {
        resultClient.release();
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('worker_intent_lease_lost:')) {
        throw error;
      }
      // Twilio already returned a valid SID. Any persistence failure after
      // provider acceptance is terminally ambiguous and must never requeue.
      await recordFailure(row, error, true);
      ambiguous += 1;
      continue;
    }

    sent += 1;
  }

  return { sent, ambiguous, failed, leaseLost, deferred, expired };
}

export async function countAgedWorkerIntentOutbox(
  pool: { connect(): Promise<PoolClient> },
  ageHours = 24,
): Promise<number> {
  if (!Number.isInteger(ageHours) || ageHours < 1 || ageHours > 168) {
    throw new Error('worker_intent_backlog_age_hours_invalid');
  }
  const client = await pool.connect();
  try {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM whatsapp_outbox
        WHERE source_type = 'worker_intent'
          AND status = 'pending'
          AND created_at < now() - ($1 || ' hours')::interval`,
      [String(ageHours)],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    client.release();
  }
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
