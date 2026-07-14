import { stripe, logResult } from './lib/client';

// Spec S15: implementation target is Accounts v2 recipient accounts.
// stripe@22.3.0 exposes typed v2 surfaces under stripe.v2.core.accounts — use the
// typed call, no `as any`. If the compiler rejects a field, consult the SDK types
// (node_modules/stripe/types/V2/Core/Accounts.d.ts) and correct THIS script; the
// corrected shape is the deliverable that Delivery B Task B5 copies.
// If the call fails with an availability error, STOP: the capability gate fails
// and the design pauses for revision (spec S15). Do not fall back to v1 silently.
async function main() {
  const account = await stripe.v2.core.accounts.create({
    include: ['configuration.recipient'],
    configuration: {
      recipient: {
        capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
      },
    },
    identity: { country: 'US', entity_type: 'individual' },
    contact_email: 'spike-worker@example.com',
    metadata: { jale_worker_id: '00000000-0000-4000-8000-000000000001', jale_spike: 'true' },
    dashboard: 'none',
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
  }, { idempotencyKey: 'jale-spike-recipient-account-v1' });
  logResult('03 recipient account', { accountId: account.id });
  console.log(`\nAdd to .env:  SPIKE_CONNECTED_ACCOUNT_ID=${account.id}`);
}
main().catch((e) => { console.error('CAPABILITY GATE CHECK FAILED:', e.message); process.exit(1); });
