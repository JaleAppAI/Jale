import { stripe, logResult } from './lib/client';

async function main() {
  const accountId = process.env.SPIKE_CONNECTED_ACCOUNT_ID;
  if (!accountId) throw new Error('Set SPIKE_CONNECTED_ACCOUNT_ID in .env.');
  // Wallet mode requires manual payout schedule (spec S9.1).
  // stripeAccount is a RequestOptions field (second arg), not a BalanceRetrieveParams field.
  const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
  const available = balance.available.find((b) => b.currency === 'usd')?.amount ?? 0;
  if (available <= 0) {
    // Gate rule: no payout created = FAIL (exit 2 = retryable, not a capability failure).
    console.error('FAIL(retryable): no available balance yet — sandbox transfers can take a moment. Re-run until a payout is actually created.');
    process.exit(2);
  }
  // Prove a standard payout without draining the balance reserved for proof 07.
  const amount = Math.min(available, 5000);
  const payout = await stripe.payouts.create(
    { amount, currency: 'usd', method: 'standard' },
    { stripeAccount: accountId },
  );
  if (!payout.id) { console.error('FAIL: payout not created'); process.exit(1); }
  logResult('06 manual payout', { payoutId: payout.id, amount: payout.amount, status: payout.status });
  console.log('PROOF 6: PASS');
}
main().catch((e) => { console.error('CAPABILITY GATE CHECK FAILED:', e.message); process.exit(1); });
