import { stripe, logResult } from './lib/client';

async function main() {
  const priceId = process.env.SPIKE_PRICE_ID;
  const attempt = process.env.SPIKE_ATTEMPT ?? '1';
  if (!priceId) throw new Error('Set SPIKE_PRICE_ID in .env (from script 01).');
  const customer = await stripe.customers.create(
    { metadata: { jale_spike: 'true' } },
    { idempotencyKey: 'jale-spike-billing-customer-v1' },
  );
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customer.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: 'http://localhost:3000/billing/return?ok=1',
    cancel_url: 'http://localhost:3000/billing/return?ok=0',
  }, { idempotencyKey: `jale-spike-subscription-checkout-${attempt}` });
  logResult('02 checkout', { customerId: customer.id, sessionId: session.id });
  console.log(`\nOpen this URL in a browser and pay with 4242 4242 4242 4242:\n${session.url}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
