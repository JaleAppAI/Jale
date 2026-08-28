import type { PoolClient } from 'pg';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { buildRawEmail } from './email-mime';

/**
 * SESv2, not SESv1, and RAW content rather than the structured body.
 *
 * The structured body cannot carry an arbitrary header, and RFC 8058 one-click
 * unsubscribe IS a pair of headers -- which Gmail and Yahoo now require of
 * bulk senders, and without which the digest's deliverability degrades
 * silently. lib/email-mime.ts builds the message; this module still owns the
 * claim/send/finalise state machine, unchanged.
 *
 * `MessageId` from the response is no longer discarded: it lands in
 * email_outbox.ses_message_id (migration 087) and is the ONLY key an SES
 * bounce or complaint notification can be joined back to a row on.
 */
const sesClient = new SESv2Client({ maxAttempts: 1 });
export const MAX_EMAIL_SEND_ATTEMPTS = 5;
const MAX_RETRY_DELAY_SECONDS = 3600;

/**
 * The `headers` JSONB bag (migration 087). Deliberately narrow: producers put
 * only what the MIME builder knows how to place, so an unrecognised key can
 * never become an arbitrary attacker-chosen SMTP header.
 */
export interface EmailOutboxHeaders {
  unsubscribe_url?: string;
}

export interface QueueEmailInput {
  recipientEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  sourceType: string;
  sourceId: string;
  idempotencyKey?: string | null;
  /** Digest rows carry an unsubscribe URL; billing-pause rows carry none. */
  headers?: EmailOutboxHeaders | null;
}

interface EmailOutboxRow {
  id: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  headers: EmailOutboxHeaders | null;
  attempt_count: number;
}

/**
 * `headers` is deliberately NOT compared. The idempotency contract is about
 * the MESSAGE -- who it goes to and what it says -- and headers is delivery
 * metadata: the unsubscribe URL embeds the employer's current
 * unsubscribe_token_version, so a same-key re-queue after a version bump would
 * differ there and nowhere else. Treating that as a conflict would roll back
 * the producer's whole per-employer transaction and cost the employer their
 * digest over a header.
 */
function sameQueuedEmail(row: Record<string, unknown>, input: QueueEmailInput): boolean {
  return row.recipient_email === input.recipientEmail
    && row.subject === input.subject
    && row.body_text === input.bodyText
    && (row.body_html ?? null) === (input.bodyHtml ?? null)
    && row.source_type === input.sourceType
    && row.source_id === input.sourceId;
}

/** Queue an email inside the caller's transaction. This function never commits. */
export async function queueEmail(client: PoolClient, input: QueueEmailInput): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sourceId)) {
    throw new Error('email_outbox_source_id_invalid');
  }
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO email_outbox
       (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key, headers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, recipient_email, subject, body_text, body_html, source_type, source_id`,
    [
      input.recipientEmail,
      input.subject,
      input.bodyText,
      input.bodyHtml ?? null,
      input.sourceType,
      input.sourceId,
      input.idempotencyKey ?? null,
      input.headers ? JSON.stringify(input.headers) : null,
    ],
  );

  if (inserted.rows[0]) return String(inserted.rows[0].id);
  if (!input.idempotencyKey) throw new Error('email_outbox_insert_failed');

  const existing = await client.query<Record<string, unknown>>(
    `SELECT id, recipient_email, subject, body_text, body_html, source_type, source_id
       FROM email_outbox
      WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('email_outbox_idempotency_lookup_failed');
  if (!sameQueuedEmail(row, input)) throw new Error('email_outbox_idempotency_conflict');
  return String(row.id);
}

function senderAddress(): string {
  const sender = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!sender || sender.length > 320 || !sender.includes('@')) {
    throw new Error('email_from_address_missing_or_invalid');
  }
  return sender;
}

function requestTimeoutMs(): number {
  const value = Number(process.env.EMAIL_SEND_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(value) || value < 500 || value > 15000) {
    throw new Error('email_send_timeout_invalid');
  }
  return value;
}

/**
 * Optional. Absent means "this deployment has no SES configuration set", which
 * is the dev-synth shape: the message still sends, it just produces no
 * bounce/complaint events. Never a hard failure -- an unset event pipeline
 * must not stop mail going out.
 */
function configurationSetName(): string | null {
  const value = process.env.EMAIL_CONFIGURATION_SET?.trim();
  return value ? value : null;
}

/**
 * Reads the one header the MIME builder understands out of the row's JSONB
 * bag. Migration 087's CHECK already guarantees an object or NULL, but this is
 * data from a table several producers can write, so the shape is re-checked
 * here rather than trusted.
 */
function unsubscribeUrlOf(headers: EmailOutboxHeaders | null): string | null {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const value = (headers as Record<string, unknown>).unsubscribe_url;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function definiteProviderRejection(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_.:-]{1,100}$/.test(error.name)) return error.name;
  return 'ses_send_failed';
}

/**
 * Claiming is committed before SES. The committed send_unknown state is the
 * crash boundary: if the process dies after SES accepts, the row is never
 * automatically sent again. Only a definite provider 4xx becomes retryable.
 */
export async function sendPendingEmails(client: PoolClient, limit = 25): Promise<number> {
  const sender = senderAddress();
  const timeoutMs = requestTimeoutMs();
  const configurationSet = configurationSetName();
  let processed = 0;

  while (processed < limit) {
    await client.query('BEGIN');
    try {
      const claimed = await client.query<EmailOutboxRow>(
        `WITH candidate AS (
           SELECT id FROM email_outbox
            WHERE status IN ('pending', 'failed')
              AND attempt_count < $1
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE email_outbox outbox
            SET status = 'send_unknown', attempt_count = attempt_count + 1,
                last_error = 'send_in_progress', next_attempt_at = NULL
           FROM candidate
          WHERE outbox.id = candidate.id
         RETURNING outbox.id, outbox.recipient_email, outbox.subject,
                   outbox.body_text, outbox.body_html, outbox.headers,
                   outbox.attempt_count`,
        [MAX_EMAIL_SEND_ATTEMPTS],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return processed;
      }
      await client.query('COMMIT');

      // Built BEFORE the send and outside the SES try/catch, because a row
      // that cannot become a valid message will never become one: a stored CR
      // in the subject, a non-ASCII bare From. Retrying it four more times
      // just delays the discovery, so it is driven straight to the attempt cap
      // and left terminally `failed` where an operator can find it. This is
      // the ONE path that fails a row without ever asking SES.
      let raw: Buffer;
      try {
        raw = buildRawEmail({
          from: sender,
          to: row.recipient_email,
          subject: row.subject,
          bodyText: row.body_text,
          bodyHtml: row.body_html,
          unsubscribeUrl: unsubscribeUrlOf(row.headers),
          configurationSet,
        });
      } catch (buildError) {
        const code = safeErrorCode(buildError);
        await client.query(
          `UPDATE email_outbox
              SET status = 'failed', last_error = $2, attempt_count = $3,
                  next_attempt_at = NULL, sent_at = NULL
            WHERE id = $1`,
          [row.id, code, MAX_EMAIL_SEND_ATTEMPTS],
        );
        console.error('email_outbox_unsendable', {
          event: 'email_outbox_unsendable', outboxId: row.id, code,
        });
        processed += 1;
        continue;
      }

      let sesError: unknown = null;
      let sesMessageId: string | null = null;
      try {
        const response = await sesClient.send(
          new SendEmailCommand({
            Destination: { ToAddresses: [row.recipient_email] },
            Content: { Raw: { Data: raw } },
            // Redundant with the X-SES-CONFIGURATION-SET header the builder
            // writes, and deliberately so: the header is the documented raw
            // mechanism, the parameter is SESv2's first-class one, they carry
            // the same value, and the API wins if they ever disagree. Belt and
            // braces on the one link that routes bounces to the handler.
            ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
          }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        );
        sesMessageId = typeof response.MessageId === 'string' ? response.MessageId : null;
      } catch (error) {
        sesError = error;
      }

      if (sesError === null) {
        // The `status = 'send_unknown'` guard is the crash boundary and stays.
        // Its cost, now that there is something to persist: if the guard does
        // NOT match, ses_message_id never lands, and a later bounce for this
        // message is an unknown-id metric rather than a digest switched off.
        // Losing the attribution is the correct trade against writing over a
        // row whose state something else already moved.
        await client.query(
          `UPDATE email_outbox
              SET status = 'sent', last_error = NULL, sent_at = now(), next_attempt_at = NULL,
                  ses_message_id = COALESCE($2, ses_message_id)
            WHERE id = $1 AND status = 'send_unknown'`,
          [row.id, sesMessageId],
        );
      } else {
        const code = safeErrorCode(sesError);
        if (definiteProviderRejection(sesError)) {
          if (row.attempt_count >= MAX_EMAIL_SEND_ATTEMPTS) {
            await client.query(
              `UPDATE email_outbox SET status = 'failed', last_error = $2,
                       next_attempt_at = NULL, sent_at = NULL WHERE id = $1`,
              [row.id, code],
            );
            console.error('email_outbox_attempt_cap', {
              event: 'email_outbox_attempt_cap', outboxId: row.id,
              attemptCount: row.attempt_count, code,
            });
          } else {
            const retryDelaySeconds = Math.min(
              MAX_RETRY_DELAY_SECONDS,
              60 * (2 ** Math.max(0, row.attempt_count - 1)),
            );
            await client.query(
              `UPDATE email_outbox SET status = 'failed', last_error = $2,
                       next_attempt_at = now() + ($3 * interval '1 second'), sent_at = NULL
                WHERE id = $1`,
              [row.id, code, retryDelaySeconds],
            );
            console.warn('email_outbox_retryable_failure', {
              event: 'email_outbox_retryable_failure', outboxId: row.id,
              attemptCount: row.attempt_count, code, retryDelaySeconds,
            });
          }
        } else {
          await client.query(
            `UPDATE email_outbox SET last_error = $2 WHERE id = $1 AND status = 'send_unknown'`,
            [row.id, code],
          );
          console.error('email_outbox_send_unknown', {
            event: 'email_outbox_send_unknown', outboxId: row.id,
            attemptCount: row.attempt_count, code,
          });
        }
      }
      processed += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  return processed;
}
