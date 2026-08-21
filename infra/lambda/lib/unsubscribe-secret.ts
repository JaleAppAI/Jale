import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Signing secret for the employer daily-digest one-click unsubscribe links
 * (`jale/notifications/unsubscribe-signing-secret`, created by
 * NotificationsStack).
 *
 * ── FAIL-CLOSED, deliberately unlike getVisitorSalt() ──
 * lib/referral-secrets.ts returns `null` when its salt is missing, because a
 * missing visitor salt only degrades open de-duplication. This secret is the
 * only thing binding an unsubscribe link to an employer id: a null here would
 * mean "accept an unsigned link", i.e. anyone who guesses a UUID could
 * unsubscribe any employer. So every unreadable shape (no env var, no
 * SecretString, blank value) THROWS, and the caller turns that into a 5xx.
 * This follows lib/stripe-webhook.ts's getWebhookSecret() semantics, with the
 * one difference that the stored value is a BARE STRING (CDK
 * `generateSecretString` with no `generateStringKey`), not JSON — so there is
 * no field to pluck and no prefix to check, just a trimmed non-empty string.
 *
 * Rotating this secret invalidates every unsubscribe link already sitting in
 * an employer's inbox.
 */

const smClient = new SecretsManagerClient({});

let cachedSecret: string | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — same TTL as lib/db.ts

export async function getUnsubscribeSecret(): Promise<string> {
  if (cachedSecret !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSecret;

  const arn = process.env.UNSUBSCRIBE_SECRET_ARN;
  if (!arn) throw new Error('UNSUBSCRIBE_SECRET_ARN env var not set');

  // A throw here propagates without touching the cache: a transient
  // Secrets Manager failure must not poison a warm container.
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('unsubscribe_secret_missing_string');
  const value = result.SecretString.trim();
  if (value.length === 0) throw new Error('unsubscribe_secret_empty');

  cachedSecret = value;
  cachedAt = Date.now();
  return cachedSecret;
}

/** Test hook — clears the module cache. */
export function clearUnsubscribeSecretCache(): void {
  cachedSecret = undefined;
  cachedAt = 0;
}
