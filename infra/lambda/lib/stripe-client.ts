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

export async function getStripeSecret(): Promise<StripeApiSecret> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  const arn = process.env.STRIPE_SECRET_ARN;
  if (!arn) throw new Error('STRIPE_SECRET_ARN env var not set');
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('stripe_api_secret_missing_string');
  const parsed = JSON.parse(result.SecretString) as Partial<StripeApiSecret>;
  if (!parsed.secretKey?.startsWith('rk_')) throw new Error('stripe_api_secret_invalid_key');
  if (parsed.priceIdEmployerPro && !parsed.priceIdEmployerPro.startsWith('price_')) throw new Error('stripe_api_secret_invalid_price');
  cached = parsed as StripeApiSecret;
  cachedAt = Date.now();
  return cached;
}

let stripeClient: Stripe | undefined;

export async function getStripe(): Promise<Stripe> {
  if (stripeClient) return stripeClient;
  const secret = await getStripeSecret();
  stripeClient = new Stripe(secret.secretKey, {
    apiVersion: STRIPE_API_VERSION,
  });
  return stripeClient;
}

export function clearStripeCache(): void {
  cached = undefined;
  cachedAt = 0;
  stripeClient = undefined;
}
