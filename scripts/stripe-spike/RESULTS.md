# Stripe Capability Spike Results (spec S15)

| # | Proof | Script | Result | Object IDs / notes |
|---|-------|--------|--------|--------------------|
| 1 | Product + $20/mo employer_pro Price | 01 | PASS (2026-07-03) | prod_UokL4oOhGOWFLM / price_1Tp6qyBYW8iDScy5viWic0Fj, unit_amount 2000 usd/month |
| 2 | Subscription Checkout Session | 02 | PASS (2026-07-03) | cus_UokQ2jaToLbLcl → sub_1Tp6wyBYW8iDScy5ZnwsjkIr status=active, price_1Tp6qyBYW8iDScy5viWic0Fj, cancel_at_period_end=false. **GATE A CLOSED** |
| 3 | Accounts v2 recipient connected account | 03 | PASS (2026-07-03) | acct_1Tp6rjBYW8B2HB5a — identical ID across two runs (idempotencyKey jale-spike-recipient-account-v1). Typed call: `stripe.v2.core.accounts.create` with `configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested=true`, `dashboard:'none'`, `defaults.responsibilities.{fees,losses}_collector='application'` — compiles clean on stripe@22.3.0, no `as any` |
| 4 | Hosted onboarding -> transfers capability active | 04 | PASS (2026-07-03) | acct_1Tp6rjBYW8B2HB5a: configuration.recipient.capabilities.stripe_balance.stripe_transfers.status=active AND payouts.status=active. Retrieved via typed `stripe.v2.core.accounts.retrieve(id, { include: ['configuration.recipient'] })` |
| 5 | Separate charge + transfer (source_transaction) | 05 | PASS (2026-07-03) | pi_3Tp725BYW8iDScy508PVRk5z / ch_3Tp725BYW8iDScy50uBGJPmB / tr_3Tp725BYW8iDScy50yTZWZLZ ($150). Identical IDs on rerun (idempotencyKey jale-spike-charge-1 / jale-spike-transfer-1). Connected acct: pending 15000, instant_available 15000, available 0 |
| 6 | Manual standard payout | 06 | PASS (2026-07-03) | available balance $80 (funded via one-off bypass-pending charge ch_3Tp74xBYW8iDScy50rmKUWEm + transfer tr_3Tp74xBYW8iDScy50jBepUvx, since the canonical pm_card_visa transfer stays `pending` under test-mode payout schedule) → standard payout po_1Tp75ABYW8B2HB5aO047txoa $50 status=pending. Delivery B note: wallet accounts must set manual payout schedule (spec S9.1) so funds don't auto-pay out |
| 7 | Instant payout eligibility + trigger | 07 | PASS (2026-07-03) | instant_available 15000 → instant payout po_1Tp74EBYW8B2HB5a4Y7zxMQk status=pending, method=instant. Connected acct acct_1Tp6rjBYW8B2HB5a |
| 8 | v1 payout/transfer/checkout webhooks arrive (stripe listen) | 08 | PASS (2026-07-03) | All 5 required types cryptographically verified in one window via stripe listen → 127.0.0.1:4242. Platform: checkout.session.completed (evt_3Tp7h6BYW8iDScy5T6Z2SJbA), payment_intent.succeeded (evt_3Tp7g2BYW8iDScy51JpMMl4q), transfer.created (evt_3Tp7g2BYW8iDScy51OJqt7a3). Connect (acct_1Tp6rjBYW8B2HB5a, scope verified): account.updated (evt_1Tp7g8BYW8B2HB5aqVT2jQN4), payout.created (evt_1Tp7gCBYW8B2HB5aDTPQYxEE). NOTE: account.updated only fires from the **v1** accounts API — the v2 accounts.update emits v2-namespaced events, so Delivery B's connect webhook must subscribe to the v1 event contract for legacy account.updated |
| 9 | Funds segregation available to Jale? (manual, dashboard/support) | n/a | OPERATOR ACTION REQUIRED | Ask Stripe (dashboard/support) whether the Jale platform can enroll in "Funds segregation for separate charges and transfers (`allocated_funds`)", incl. required preview header + production-enrollment process. Record sanitized answer + date + support case ref here. This is the last item gating Gate B. |

## Reproducibility record

- Node version: v25.7.0
- Exact stripe-node version (`22.3.0`): confirmed — `Stripe.PACKAGE_VERSION` == 22.3.0
- Stripe API version (`2026-06-24.dahlia`): confirmed — `Stripe.API_VERSION` == 2026-06-24.dahlia; stripe listen reported `API Version [2026-06-24.dahlia]`
- Stripe CLI version: _(operator: run `stripe version` and record)_
- Sandbox/account identifier (non-secret): "Jale App sandbox"; connected recipient acct_1Tp6rjBYW8B2HB5a; billing customer cus_UokQ2jaToLbLcl
- Snapshot event-destination API version: stripe listen forwarded snapshot (v1) events at 2026-06-24.dahlia (matches SDK pin)
- Accounts v2 recipient capability event observed (type + event ID only): v1 `account.updated` on connect endpoint (evt_1Tp7g8BYW8B2HB5aqVT2jQN4); NOTE only the **v1** accounts API emits `account.updated` — v2 accounts.update emits v2-namespaced events instead
- Restricted-key permission profile used: sandbox secret key (`sk_test_`/`rk_test_` prefix validated at runtime; value never read)

## Delivery B carry-over findings (from spike)

1. **Connect webhook must subscribe to v1 `account.updated`** — the v2 accounts API does NOT emit it (emits v2-namespaced events). Wallet readiness detection depends on this contract (spec §S15 / plan rule 10: v1 snapshot vs v2 thin events are different contracts — confirmed empirically).
2. **`stripe.balance.retrieve` takes `stripeAccount` in the RequestOptions (2nd arg), not params** — corrected in scripts 06/07; Delivery B code must follow.
3. **`Stripe.LatestApiVersion` is not namespace-exported in 22.3.0** — pin via `typeof Stripe.API_VERSION`.
4. **pm_card_visa charges land in `pending`/`instant_available`, not `available`** under test-mode payout schedule; standard payouts need `available`. Wallet accounts must use manual payout schedule (spec §S9.1).
5. **PowerShell mangles bare comma-lists** passed to native exes (`stripe listen --events a,b,c`); quote them. Windows `localhost` may resolve to IPv6 `::1` — bind/forward to explicit `127.0.0.1`. (Operator tooling note, not Delivery B code.)
