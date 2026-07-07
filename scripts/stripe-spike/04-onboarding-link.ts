import { stripe, logResult } from './lib/client';

async function main() {
  const accountId = process.env.SPIKE_CONNECTED_ACCOUNT_ID;
  if (!accountId) throw new Error('Set SPIKE_CONNECTED_ACCOUNT_ID in .env (from script 03).');
  // Typed v2 Account Links (available in stripe@22.3.0's pinned API version).
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        refresh_url: 'http://localhost:3000/wallet/onboarding?refresh=1',
        return_url: 'http://localhost:3000/wallet/onboarding?done=1',
      },
    },
  });
  logResult('04 onboarding link', { accountId });
  console.log(`\nOpen and complete with Stripe test data (any test SSN 000-00-0000 etc.):\n${link.url}`);
}
main().catch((e) => { console.error('CAPABILITY GATE CHECK FAILED:', e.message); process.exit(1); });
