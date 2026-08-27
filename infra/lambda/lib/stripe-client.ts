import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
// tsconfig has no esModuleInterop, so `stripe`'s `export =` typing requires the
// TS import-equals form rather than `import Stripe from 'stripe'` (brief's
// literal import fails TS1259 under this repo's compiler options).
import Stripe = require('stripe');

// Same 5-minute cache pattern as lib/db.ts getDbSecret.
interface StripeApiSecret {
  secretKey: string;               // restricted key, rk_test_/rk_live_
  priceIdEmployerPro?: string;     // billing API/config secret only
  portalConfigurationId?: string;  // billing API/config secret only
}

let cached: StripeApiSecret | undefined;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
const smClient = new SecretsManagerClient({});

// stripe@22.3.0 does not namespace-export Stripe.LatestApiVersion (spike-proven);
// typeof Stripe.API_VERSION is the same literal type and keeps the compile-time pin.
export const STRIPE_API_VERSION: typeof Stripe.API_VERSION = '2026-06-24.dahlia';

/**
 * Thrown for permanent Stripe configuration problems (missing/malformed secret,
 * bad key/price prefixes, an unreadable Secrets Manager entry). These are NOT
 * provider outages — callers must classify them as terminal (e.g. HTTP 500
 * `billing_configuration_invalid`), never as a retryable 503. Transient
 * Secrets Manager failures (throttling, SM 5xx) are deliberately rethrown as
 * plain errors so they keep the existing retryable classification.
 */
export class StripeConfigError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'StripeConfigError';
  }
}

export async function getStripeSecret(): Promise<StripeApiSecret> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const arn = process.env.STRIPE_SECRET_ARN;
  if (!arn) throw new StripeConfigError('stripe_secret_arn_missing');

  let result;
  try {
    result = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    // Throttling and SM-side 5xx are transient — rethrow as-is so the caller's
    // existing retryable (503) classification still applies.
    if (e?.name === 'ThrottlingException') throw err;
    if (typeof e?.$metadata?.httpStatusCode === 'number' && e.$metadata.httpStatusCode >= 500) throw err;
    // A missing or inaccessible secret is a permanent configuration problem,
    // not a provider outage. Other explicit Secrets Manager 4xx responses
    // (for example a malformed ARN) are terminal for the same reason. Errors
    // without an HTTP response remain untouched because they may be transient
    // transport failures.
    if (e?.name === 'ResourceNotFoundException' || e?.name === 'AccessDeniedException') {
      throw new StripeConfigError('stripe_api_secret_unreadable');
    }
    if (typeof e?.$metadata?.httpStatusCode === 'number'
      && e.$metadata.httpStatusCode >= 400
      && e.$metadata.httpStatusCode < 500) {
      throw new StripeConfigError('stripe_api_secret_unreadable');
    }
    throw err;
  }

  if (!result.SecretString) throw new StripeConfigError('stripe_api_secret_missing_string');

  let parsed: Partial<StripeApiSecret>;
  try {
    parsed = JSON.parse(result.SecretString) as Partial<StripeApiSecret>;
  } catch {
    throw new StripeConfigError('stripe_api_secret_malformed');
  }

  if (!parsed.secretKey?.startsWith('rk_')) throw new StripeConfigError('stripe_api_secret_invalid_key');
  if (parsed.priceIdEmployerPro && !parsed.priceIdEmployerPro.startsWith('price_')) {
    throw new StripeConfigError('stripe_api_secret_invalid_price');
  }
  cached = parsed as StripeApiSecret;
  cachedAt = Date.now();
  return cached;
}

let stripeClient: Stripe | undefined;
// The key `stripeClient` was constructed with, so a rotation can be detected.
let stripeClientKey: string | undefined;

export async function getStripe(): Promise<Stripe> {
  // Always consult getStripeSecret(): within CACHE_TTL_MS that is a cheap
  // in-memory read, and once the TTL lapses it is the single Secrets Manager
  // call that surfaces an operator key rotation. Memoizing the client without
  // this check left every warm container authenticating with the retired key
  // (e.g. rk_test_ after a cutover to rk_live_) until it happened to recycle.
  const secret = await getStripeSecret();
  if (stripeClient && stripeClientKey === secret.secretKey) return stripeClient;
  // The key changed (or there is no client yet) — rebuild, keeping the pin.
  stripeClient = new Stripe(secret.secretKey, {
    apiVersion: STRIPE_API_VERSION,
  });
  stripeClientKey = secret.secretKey;
  return stripeClient;
}

export function clearStripeCache(): void {
  cached = undefined;
  cachedAt = 0;
  stripeClient = undefined;
  stripeClientKey = undefined;
}
