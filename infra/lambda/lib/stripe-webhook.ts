import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Stripe = require('stripe');

// Separate signing-secret loader for the webhook verifier Lambda.
// This module NEVER reads STRIPE_SECRET_ARN (API key) and NEVER constructs
// a Stripe API client. It only loads and caches the webhook signing secret.
// Mirrors the 5-minute TTL cache pattern from lib/db.ts and lib/stripe-client.ts.

const smClient = new SecretsManagerClient({});

interface WebhookSecret {
  webhookSigningSecret: string;
}

let cachedSecret: WebhookSecret | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getWebhookSecret(): Promise<WebhookSecret> {
  if (cachedSecret && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSecret;
  const arn = process.env.WEBHOOK_SECRET_ARN;
  if (!arn) throw new Error('WEBHOOK_SECRET_ARN env var not set');
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('webhook_secret_missing_string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new Error('webhook_secret_not_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('webhook_secret_not_object');
  const raw = (parsed as Record<string, unknown>).webhookSigningSecret;
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('webhook_secret_missing_field');
  if (!raw.startsWith('whsec_')) throw new Error('webhook_secret_invalid_prefix');
  cachedSecret = { webhookSigningSecret: raw };
  cachedAt = Date.now();
  return cachedSecret;
}

/**
 * Verify a Stripe v1 snapshot event using constructEvent.
 * Throws StripeSignatureVerificationError on bad signature.
 * The caller is responsible for:
 *   - Passing the exact raw bytes of the request body (Buffer, not re-parsed string).
 *   - Fetching the secret via getWebhookSecret().
 */
export function verifyStripeEvent(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): Stripe.Event {
  // constructEvent accepts Buffer (Uint8Array) per the SDK type WebhookPayload
  return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/** Clear the cache — used by tests to inject a fresh secret. */
export function clearWebhookSecretCache(): void {
  cachedSecret = undefined;
  cachedAt = 0;
}
