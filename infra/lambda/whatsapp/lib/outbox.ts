import type { PoolClient } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { TwilioSecret } from './twilio';

const secretsManager = new SecretsManagerClient({});

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

async function sendTwilioMessage(to: string, body: string): Promise<void> {
  const secret = await getTwilioSecret();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${secret.accountSid}/Messages.json`;
  const form = new URLSearchParams({
    MessagingServiceSid: secret.messagingServiceSid,
    To: to,
    Body: body,
  });
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
    body: string;
  }>(
    `SELECT id, sequence, whatsapp_number, body
       FROM whatsapp_outbox
      WHERE inbound_message_sid = $1
        AND status IN ('pending', 'failed')
      ORDER BY sequence`,
    [inboundMessageSid],
  );

  for (const row of pending.rows) {
    try {
      await sendTwilioMessage(`whatsapp:${row.whatsapp_number}`, row.body);
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'sent', sent_at = now()
          WHERE id = $1`,
        [row.id],
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
