import { stripe, logResult } from './lib/client';

async function main() {
  const accountId = process.env.SPIKE_CONNECTED_ACCOUNT_ID;
  if (!accountId) throw new Error('Set SPIKE_CONNECTED_ACCOUNT_ID in .env.');
  // stripeAccount is a RequestOptions field (second arg), not a BalanceRetrieveParams field.
  const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
  const instant = balance.instant_available?.[0]?.amount ?? 0;
  logResult('07 instant eligibility', { instantAvailableMinor: instant });
  if (instant <= 0) {
    // Gate rule: eligibility query succeeded but no instant payout was proven = FAIL.
    console.error('FAIL(retryable): no instant-available funds. Add an instant-eligible external account (test debit card 4000056655665556) to the connected account and re-run. Record a genuine sandbox limitation in RESULTS.md ONLY if Stripe support confirms instant payouts cannot be exercised in sandbox.');
    process.exit(2);
  }
  const payout = await stripe.payouts.create(
    { amount: instant, currency: 'usd', method: 'instant' },
    { stripeAccount: accountId },
  );
  if (!payout.id) { console.error('FAIL: instant payout not created'); process.exit(1); }
  logResult('07 instant payout', { payoutId: payout.id, status: payout.status });
  console.log('PROOF 7: PASS');
}
main().catch((e) => { console.error('CAPABILITY GATE CHECK FAILED:', e.message); process.exit(1); });
