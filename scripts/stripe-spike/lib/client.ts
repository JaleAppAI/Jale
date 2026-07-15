import 'dotenv/config';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  throw new Error('STRIPE_SECRET_KEY missing. Copy .env.example to .env and paste the sandbox key.');
}
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
  // Presence/shape check only — never print the value.
  throw new Error('STRIPE_SECRET_KEY does not look like a sandbox key (expected sk_test_/rk_test_ prefix). Refusing to run.');
}

// This literal must match Stripe.API_VERSION from the exact installed SDK.
// (stripe@22.3.0 does not export Stripe.LatestApiVersion under the namespace;
// typeof Stripe.API_VERSION is the same literal type and keeps the compile-time pin.)
export const STRIPE_API_VERSION: typeof Stripe.API_VERSION = '2026-06-24.dahlia';

export const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });

export function logResult(name: string, data: Record<string, unknown>): void {
  // Objects created in the sandbox are test data; IDs are safe to print. Never print keys/secrets/client_secret.
  console.log(`\n=== ${name} ===`);
  console.log(JSON.stringify(data, null, 2));
}
