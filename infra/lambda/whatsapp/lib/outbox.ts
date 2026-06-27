import type { PoolClient } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { TwilioSecret } from './twilio';

const secretsManager = new SecretsManagerClient({});
const FALLBACK_BODY_KEY = '__fallback_body';

// H3: poison-message guard for the scheduled admin dispatcher. A row that Twilio
// hard-rejects (4xx) flips to 'failed' and would otherwise be re-selected and
// re-sent every minute forever. Stop retrying after this many attempts; the row
// stays 'failed' with last_error set for operator follow-up.
const MAX_ADMIN_SEND_ATTEMPTS = 5;

let cachedTwilio: TwilioSecret | null = null;
let twilioCacheExp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

class AmbiguousTwilioSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousTwilioSendError';
  }
}

async function getTwilioSecret(): Promise<TwilioSecret> {
  const now = Date.now();
  if (cachedTwilio && now < twilioCacheExp) return cachedTwilio;

  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN not set');

  const r = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error('TWILIO secret empty');

  cachedTwilio = JSON.parse(r.SecretString) as TwilioSecret;
  twilioCacheExp = now + CACHE_TTL_MS;
  return cachedTwilio;
}

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
    throw error;
  }
  if (!res.ok) {
    throw new Error(`Twilio send failed with HTTP ${res.status}`);
  }
  let responseBody: { sid?: string } | null = null;
  try {
    responseBody = await res.json() as { sid?: string };
  } catch {
    responseBody = null;
  }
  return responseBody?.sid ?? null;
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
  cachedTwilio = null;
  twilioCacheExp = 0;
}
