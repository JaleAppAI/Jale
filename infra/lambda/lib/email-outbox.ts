import type { PoolClient } from 'pg';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const sesClient = new SESClient({ maxAttempts: 1 });
export const MAX_EMAIL_SEND_ATTEMPTS = 5;
const MAX_RETRY_DELAY_SECONDS = 3600;

export interface QueueEmailInput {
  recipientEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  sourceType: string;
  sourceId: string;
  idempotencyKey?: string | null;
}

interface EmailOutboxRow {
  id: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  attempt_count: number;
}

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
       (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
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
                   outbox.body_text, outbox.body_html, outbox.attempt_count`,
        [MAX_EMAIL_SEND_ATTEMPTS],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return processed;
      }
      await client.query('COMMIT');

      let sesError: unknown = null;
      try {
        await sesClient.send(
          new SendEmailCommand({
            Source: sender,
            Destination: { ToAddresses: [row.recipient_email] },
            Message: {
              Subject: { Data: row.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: row.body_text, Charset: 'UTF-8' },
                ...(row.body_html
                  ? { Html: { Data: row.body_html, Charset: 'UTF-8' } }
                  : {}),
              },
            },
          }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        );
      } catch (error) {
        sesError = error;
      }

      if (sesError === null) {
        await client.query(
          `UPDATE email_outbox
              SET status = 'sent', last_error = NULL, sent_at = now(), next_attempt_at = NULL
            WHERE id = $1 AND status = 'send_unknown'`,
          [row.id],
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
