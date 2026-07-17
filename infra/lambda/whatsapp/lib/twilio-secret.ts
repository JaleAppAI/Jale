import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { TwilioSecret } from './twilio';

const secretsManager = new SecretsManagerClient({});
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedTwilio: TwilioSecret | null = null;
let twilioCacheExp = 0;

export async function getTwilioSecret(): Promise<TwilioSecret> {
  const now = Date.now();
  if (cachedTwilio && now < twilioCacheExp) return cachedTwilio;

  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN not set');

  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('TWILIO secret empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new Error('TWILIO secret is not valid JSON');
  }
  if (!isTwilioSecret(parsed)) {
    throw new Error('TWILIO secret missing required fields');
  }

  cachedTwilio = parsed;
  twilioCacheExp = now + CACHE_TTL_MS;
  return cachedTwilio;
}

export function requireTwilioStatusCallbackUrl(): string {
  const raw = process.env.TWILIO_STATUS_CALLBACK_URL;
  if (!raw) throw new Error('TWILIO_STATUS_CALLBACK_URL not set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TWILIO_STATUS_CALLBACK_URL must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith('/whatsapp/status-callback')
  ) {
    throw new Error('TWILIO_STATUS_CALLBACK_URL must be an HTTPS /whatsapp/status-callback URL');
  }
  return url.toString();
}

function isTwilioSecret(value: unknown): value is TwilioSecret {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.accountSid === 'string' && candidate.accountSid.startsWith('AC')
    && typeof candidate.authToken === 'string' && candidate.authToken.length > 0
    && typeof candidate.messagingServiceSid === 'string'
    && candidate.messagingServiceSid.startsWith('MG');
}

export function _clearTwilioSecretCacheForTests(): void {
  cachedTwilio = null;
  twilioCacheExp = 0;
}
