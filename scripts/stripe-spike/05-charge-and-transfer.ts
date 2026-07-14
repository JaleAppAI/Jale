import { stripe, logResult } from './lib/client';

async function main() {
  const accountId = process.env.SPIKE_CONNECTED_ACCOUNT_ID;
  const attempt = process.env.SPIKE_ATTEMPT ?? '1';
  if (!accountId) throw new Error('Set SPIKE_CONNECTED_ACCOUNT_ID in .env.');

  // Fund the platform with a test PaymentIntent (simulates employer engagement funding).
  const pi = await stripe.paymentIntents.create({
    amount: 15000, // $150 engagement
    currency: 'usd',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  }, { idempotencyKey: `jale-spike-charge-${attempt}` });
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) throw new Error('No charge on PaymentIntent');

  // Separate charges & transfers: transfer full amount using the charge as source (spec S8.6).
  const transfer = await stripe.transfers.create({
    amount: 15000,
    currency: 'usd',
    destination: accountId,
    source_transaction: chargeId,
  }, { idempotencyKey: `jale-spike-transfer-${attempt}` });
  logResult('05 charge+transfer', { paymentIntentId: pi.id, chargeId, transferId: transfer.id });
  console.log(`\nAdd to .env:  SPIKE_PAYMENT_INTENT_ID=${pi.id}\nAdd to .env:  SPIKE_CHARGE_ID=${chargeId}`);
}
main().catch((e) => { console.error('CAPABILITY GATE CHECK FAILED:', e.message); process.exit(1); });
