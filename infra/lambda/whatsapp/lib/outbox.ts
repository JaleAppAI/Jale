import type { PoolClient } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { TwilioSecret } from './twilio';

const secretsManager = new SecretsManagerClient({});
const FALLBACK_BODY_KEY = '__fallback_body';

let cachedTwilio: TwilioSecret | null = null;
let twilioCacheExp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio send failed ${res.status}: ${text}`);
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
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'failed',
                attempt_count = attempt_count + 1,
                last_error = $1
          WHERE id = $2`,
        [(err as Error).message, row.id],
      );
      throw err;
    }
  }
}

export function _clearOutboxTwilioSecretCacheForTests(): void {
  cachedTwilio = null;
  twilioCacheExp = 0;
}
