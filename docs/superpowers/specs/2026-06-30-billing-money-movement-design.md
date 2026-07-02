# Jale Billing and Contractor Money Movement Design

**Status:** Approved in design review on 2026-06-30; amended for future Jale Gigs compatibility; amended 2026-07-01 after adversarial review (binding re-proposal, stale-state expiry, chargeback representability, payout-mode snapshot, platform fee reservation, per-pool re-auth); amended 2026-07-01 with planning decisions (refund_reason semantics, $20/mo sandbox pricing, Phase 0 local spike, A+B sequential planning)
**Scope:** Employer subscription plumbing, reusable contractor payment engagements, worker connected balances, and sandbox payouts
**Baseline:** Jale migrations currently end at `033_pay_interval_experience_months_worker_certifications.sql`

## 1. Purpose

Jale needs two related but operationally distinct payment systems:

1. Employer subscriptions that grant higher job-posting limits and future paid entitlements.
2. Prefunded contractor engagements that guarantee an agreed payment, release it after completion, and let the worker retain funds in a connected balance or automatically deposit them to a bank.

The first release builds real, end-to-end Stripe sandbox flows for employer-funded jobs. It does not move live money, enable a paid worker subscription, implement Jale Gigs, or allow workers to spend connected balances on gigs. The payment domain uses payer/payee identities and source-specific bindings so a future `GigsStack` can reuse funding, completion, dispute, release, and payout processing without weakening current relational integrity.

## 2. Approved Product Decisions

- Employer subscriptions unlock additional job postings and future features.
- Workers remain on a free plan in this release.
- A payment belongs to one hired worker application, not to the job as a whole.
- The employer and worker agree on one fixed USD amount for the engagement.
- After both parties accept, the employer must prefund the engagement.
- An engagement is not payment-guaranteed until Stripe confirms successful capture.
- The worker completes Stripe-hosted onboarding before the engagement can become payment-ready.
- The worker marks the engagement complete.
- The employer can approve immediately or dispute within 48 hours.
- Jale automatically releases payment if the employer takes no action during the 48-hour window.
- The worker chooses one payout mode:
  - `wallet`: retain released funds in the worker's Stripe connected-account balance until the worker requests a payout.
  - `direct_deposit`: automatically initiate a standard bank payout after released funds become available.
- Eligible workers can request an instant payout from the wallet.
- Jale calls this a **payment guarantee** or **prefunded payment**, never legal escrow.
- Contractor payments ship first. A future payroll or earned-wage provider must integrate through a separate boundary.
- Current public engagement APIs remain employer-job-specific.
- The payment core identifies participants as payer and payee rather than assuming that only employers can pay.
- Future Jale Gigs can bind an accepted worker-to-worker gig to the same payment core through a new source-specific table.
- Future wallet-funded subscriptions and wallet-funded gigs require separate Stripe capability, consent, risk, tax, and legal gates.

## 3. Corrections to the Source Claude Plan

The source plan was directionally useful but contained assumptions that must not become implementation requirements:

- The repository is not at migration `006`; it currently ends at `033`. The next migrations are `034` and `035`.
- Matching, AI, admin, frontend, and other stacks now exist. New payment stacks must follow the current `infra/bin/jale-app.ts` topology rather than the older eight-stack description.
- Stripe Connect reduces the amount of financial infrastructure Jale must build, but it does not automatically eliminate all money-transmission, marketplace, tax, worker-classification, or consumer-protection analysis.
- Stripe explicitly does not provide legal escrow.
- Stripe funds segregation is a private-preview capability. The design cannot assume it is enabled.
- Separate charges and transfers make Jale's platform responsible for payment fees, refunds, disputes, and negative platform balances.
- A job-level `job_payments` row is insufficient because one job can hire and pay multiple workers.
- An employer-specific engagement table would make a future worker-funded gig require a payment-domain rewrite. Source-specific binding tables preserve foreign keys while keeping the financial lifecycle reusable.
- Stripe Accounts v1 remains supported. Accounts v2 is the preferred design target, but Jale must confirm its sandbox and account capabilities before implementation depends on preview APIs.

## 4. Architecture

### 4.1 Separate stacks from day one

Add two independent downstream stacks after `ApiStack`.

#### `BillingStack`

Owns:

- Employer plan and entitlement APIs
- Stripe Customer mapping
- Stripe Checkout and Billing Portal sessions
- Subscription webhook endpoint
- Billing webhook queue and dead-letter queue
- Subscription webhook processor
- Billing alarms and dashboards
- Billing-specific restricted Stripe key and webhook signing secret

#### `MoneyMovementStack`

Owns:

- Reusable payment-engagement APIs and domain services
- Stripe Connect account onboarding
- Employer funding Checkout
- Completion, dispute, release, refund, and payout commands
- Payment/Connect webhook endpoint
- Payment webhook queue and dead-letter queue
- Durable payment command queue and dead-letter queue
- Scheduled automatic-release and direct-deposit sweepers
- IAM-authorized operator command Lambda
- Payment alarms and dashboards
- Money-movement restricted Stripe key and webhook signing secret

Neither stack imports the other. Both receive the existing API, Cognito authorizers, VPC, subnets, and required database secrets through props. Both add routes to the API using the established downstream-stack pattern.

The first release exposes only employer-job engagement routes. Internally, `MoneyMovementStack` creates and operates payment engagements using payer/payee IDs plus a source binding. A future `GigsStack` owns gig discovery, offers, bookings, and worker-to-worker permissions, then calls the same internal engagement-creation contract after a gig booking is accepted. `GigsStack` does not duplicate financial state machines or Stripe calls.

### 4.2 Trust boundaries

Jale is authoritative for:

- Plan definitions and entitlements
- Agreed engagement terms and source binding
- Participant authorization
- Completion intent
- Dispute intent and operator resolution
- Payout preference

Stripe is authoritative for:

- Customers
- Checkout Sessions
- Subscriptions and invoices
- PaymentIntents and charges
- Connected accounts and capability status
- Transfers
- Connected-account balances
- Refunds and payouts

Jale mirrors Stripe financial state only through verified webhook events or explicit provider reconciliation. A successful synchronous API response is not, by itself, the final financial state.

### 4.3 Network boundary

Add `billingLambdaSg` and `paymentsLambdaSg` to `NetworkStack` instead of attaching payment Lambdas to the shared allow-all `lambdaSg`.

- Allow database traffic only to the shared RDS security group.
- Allow outbound TCP 443 through the existing NAT Gateway.
- Do not claim that a security group restricts HTTPS to Stripe domains; it only reduces the protocol and port blast radius.
- Create every Lambda through `JaleLambdaFunction`, preserving Jale's private-with-egress placement. Webhook verifier Lambdas use the stack-specific security group but receive no database-secret grant.

## 5. Database Design

### 5.1 Migration `034_billing_foundation.sql`

Create:

#### `billing_plans`

- `code TEXT PRIMARY KEY`
- `audience TEXT CHECK (audience IN ('employer', 'worker'))`
- `display_name TEXT`
- `entitlements JSONB NOT NULL`
- `active BOOLEAN NOT NULL`
- timestamps

Seed sandbox/default definitions:

- `employer_free`: `{"active_job_limit": 1}`
- `employer_pro`: `{"active_job_limit": 10}`
- `worker_free`: `{}`

The sandbox `employer_pro` price is $20/month. The Stripe Product and Price are created by a reproducible script, and the resulting Stripe price ID lives in configuration (the billing secret/config, never source code), so real production pricing is a pure configuration change plus a new Price object.

These values are data, not hardcoded application branches. Entitlement keys are namespaced by feature. A future `GigsStack` may define keys such as `gigs.post_limit`, `gigs.featured_slots`, and `gigs.fee_discount`; this release does not seed or read those keys and does not create a paid worker plan.

#### `billing_customers`

- `user_id UUID PRIMARY KEY REFERENCES users(id)`
- `provider TEXT NOT NULL CHECK (provider = 'stripe')`
- `provider_customer_id TEXT UNIQUE NOT NULL`
- timestamps

#### `subscriptions`

- `id UUID PRIMARY KEY`
- `user_id UUID NOT NULL REFERENCES users(id)`
- `plan_code TEXT NOT NULL REFERENCES billing_plans(code)`
- `provider_subscription_id TEXT UNIQUE`
- `status TEXT NOT NULL`
- `current_period_start TIMESTAMPTZ`
- `current_period_end TIMESTAMPTZ`
- `cancel_at_period_end BOOLEAN NOT NULL DEFAULT false`
- `grace_ends_at TIMESTAMPTZ`
- timestamps

Allow one current Stripe subscription per user through a partial unique index over nonterminal statuses.

#### `billing_operations`

Stores durable API idempotency:

- actor
- operation type
- client idempotency key
- canonical request hash
- provider idempotency key
- provider object ID
- status
- cached response
- timestamps

Unique key: `(actor_user_id, operation_type, client_idempotency_key)`.

#### `billing_webhook_events`

- `stripe_event_id TEXT PRIMARY KEY`
- event type
- Stripe object ID
- processing status
- attempt count
- received/processed timestamps
- last safe error code

### 5.2 Migration `035_contractor_payments.sql`

Create:

#### `payment_engagements`

- `id UUID PRIMARY KEY`
- `origin_type TEXT NOT NULL CHECK (origin_type IN ('job_application'))`
- `payer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`
- `payee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`
- `funding_source TEXT NOT NULL DEFAULT 'external_card' CHECK (funding_source IN ('external_card'))`
- `amount_minor BIGINT NOT NULL`
- `platform_fee_minor BIGINT NOT NULL DEFAULT 0`
- `currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd')`
- `start_date DATE NOT NULL`
- `terms_summary TEXT NOT NULL`
- `state TEXT NOT NULL`
- `accepted_at TIMESTAMPTZ`
- `funded_at TIMESTAMPTZ`
- `started_at TIMESTAMPTZ`
- `completion_submitted_at TIMESTAMPTZ`
- `auto_release_at TIMESTAMPTZ`
- `released_at TIMESTAMPTZ`
- `disputed_at TIMESTAMPTZ`
- `refund_reason TEXT CHECK (refund_reason IN ('cancellation', 'dispute_resolution'))` — set when a refund path begins; NULL otherwise
- optimistic `version INTEGER NOT NULL DEFAULT 1`
- timestamps

Require `payer_user_id <> payee_user_id`. Do not require a particular `users.user_type` in the payment table. Current employer-job APIs enforce an employer payer and worker payee; the domain model remains reusable for a future worker payer.

Allowed states:

`proposed`, `accepted`, `funding_pending`, `funded`, `in_progress`, `completion_pending`, `release_pending`, `released`, `disputed`, `refund_pending`, `refunded`, `cancelled`, `funding_failed`.

The amount must be positive and no greater than the configured pilot maximum. After funding begins, participants, origin, funding source, amount, currency, and terms are immutable. V1 always sets `platform_fee_minor` to 0 and transfers the full `amount_minor`; the column exists so a future take-rate does not require a migration on live financial rows. The transfer amount is `amount_minor - platform_fee_minor`. V1 accepts only `external_card`; a future migration may add `connected_balance` only after its separate Stripe and legal gate passes.

#### `job_payment_engagements`

- `engagement_id UUID PRIMARY KEY REFERENCES payment_engagements(id) ON DELETE CASCADE`
- `job_application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE RESTRICT`
- timestamp

A deferred constraint trigger validates that:

- the application is `hired` when the engagement is created
- the payer matches the owning employer of the application job
- the payee matches the application worker
- every `origin_type = 'job_application'` payment engagement has exactly one job binding
- at most one binding per application whose engagement can still proceed or has succeeded; an application is freed for a new engagement only by a terminal-failed outcome: `cancelled`, `funding_failed`, or `refunded` with `refund_reason = 'cancellation'`. `released` permanently consumes the application, and `refunded` with `refund_reason = 'dispute_resolution'` also blocks re-proposal — a relationship that ended in an operator-refunded dispute must not quietly restart through a re-proposal on the same hire.

The plain UNIQUE on `job_application_id` is replaced by this trigger-enforced partial uniqueness. A cancelled, funding-failed, or cancellation-refunded engagement releases the application for a new proposal (a pre-work cancellation refund must not permanently block a rescheduled engagement for the same hire). A released or dispute-refunded engagement permanently consumes the application.

A future Jale Gigs migration adds `worker_gig` to the allowed origin types and creates `gig_payment_engagements(engagement_id, gig_booking_id)` with equivalent source-integrity checks. The current migration does not create gig tables or permit unbound gig engagements.

#### `engagement_payments`

One row per engagement:

- `engagement_id UUID UNIQUE NOT NULL`
- Stripe Checkout Session ID
- Stripe PaymentIntent ID, unique when present
- Stripe charge ID, unique when present
- Stripe transfer ID, unique when present
- Stripe refund ID, unique when present
- funding, transfer, refund, and dispute statuses
- `charge_dispute_status TEXT` mirroring Stripe `charge.dispute.*` events; Stripe dispute ID unique when present
- `allocated_funds_enabled BOOLEAN NOT NULL DEFAULT false`
- timestamps

#### `connect_accounts`

- `worker_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT`
- `stripe_account_id TEXT UNIQUE NOT NULL`
- API generation/version used
- onboarding status
- transfers capability status
- payouts capability status
- requirements-due summary without identity-document contents
- timestamps

#### `payout_preferences`

- `worker_id UUID PRIMARY KEY`
- `mode TEXT CHECK (mode IN ('wallet', 'direct_deposit'))`
- timestamps

Do not store bank or debit-card numbers.

#### `payouts`

- `id UUID PRIMARY KEY`
- `worker_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`
- optional `engagement_id`
- `amount_minor BIGINT NOT NULL`
- `currency TEXT NOT NULL DEFAULT 'usd'`
- `method TEXT CHECK (method IN ('standard', 'instant'))`
- `stripe_payout_id TEXT UNIQUE`
- fee amount
- status
- failure code safe for display
- timestamps

#### `payment_commands`

Durable command and API-idempotency record:

- command UUID
- actor
- engagement or payout reference
- origin type and source-binding reference
- command type
- client idempotency key
- canonical request hash
- deterministic Stripe idempotency key
- captured payout mode for release/payout commands
- status and attempt count
- provider object ID
- cached API response
- safe error code
- timestamps

Unique constraints cover both the client operation and business operation. Examples:

- one successful `fund` command per engagement
- one successful `release` command per engagement payment
- one command per payout request UUID

#### `payment_webhook_events`

Same event-inbox pattern as billing, scoped to payment and Connect events.

#### `payment_audit_log`

Append-only:

- actor type and actor ID
- engagement/payment/payout reference
- origin type and source-binding reference
- previous state
- next state
- reason code
- request/correlation ID
- timestamp

No update or delete grants for application roles.

### 5.3 RLS and service roles

- Billing policies expose only subscriptions owned by the current employer.
- Payment-engagement policies authorize by participant identity: the current user may read an engagement when they are its payer or payee.
- Current employer-job mutation handlers additionally require an employer payer and worker payee and validate the `job_payment_engagements` binding.
- Connected-account summaries, payout preferences, balances, and payouts remain scoped to their worker owner.
- User-facing Lambdas continue to set `app.current_user_id` inside transactions.
- Create narrowly privileged `jale_billing` and `jale_payments` service roles for webhook processors, scheduled workers, and operator commands.
- Service roles receive exact table and operation grants. Do not broaden worker or employer RLS policies and do not invent a Cognito identity for background processing.

## 6. Billing Flow

1. Every employer resolves to a free entitlement set even before a Stripe Customer exists.
2. `POST /employer/billing/checkout` validates the employer, plan code, return URLs, and idempotency key.
3. The handler creates or reuses a Stripe Customer and creates a subscription Checkout Session.
4. The frontend redirects to Stripe-hosted Checkout.
5. Checkout return is informational only.
6. A verified webhook durably records the event and queues it.
7. The billing processor mirrors the subscription and activates `employer_pro`.
8. Job creation calls a shared billing authorization function that counts active jobs and compares the count with the current entitlement. The same function evaluates grace expiry from `grace_ends_at` at job-creation time; no separate entitlement-expiry cron exists in this release.
9. On `past_due`, the current entitlement remains during a seven-day grace period.
10. When the grace period ends or the subscription terminates, new posting is blocked. Existing jobs remain visible and manageable.
11. Stripe Billing Portal handles payment-method changes, invoices, and cancellation.

## 7. Contractor Engagement and Funding Flow

1. An employer selects a `hired` application and proposes a fixed amount, start date, and terms summary.
2. Jale creates a `proposed` payment engagement plus `job_payment_engagements` binding in one transaction. The binding's trigger-enforced partial uniqueness prevents a second concurrent non-terminal engagement for the same application.
3. The worker reviews and accepts the terms.
4. The worker completes Stripe-hosted connected-account onboarding. The engagement cannot become payment-ready until the transfers capability is active.
5. The employer requests a hosted one-time funding Checkout Session.
6. The handler persists a funding command before calling Stripe and uses a deterministic Stripe idempotency key.
7. A successful `payment_intent.succeeded` webhook changes the engagement to `funded`.
8. If funds segregation is enabled for Jale's Stripe account, the PaymentIntent allocates those funds to the holding state. Otherwise, the sandbox flow uses ordinary separate charges and transfers and records `allocated_funds_enabled = false`.
9. Jale may move the engagement to `in_progress` on or after the start date.
10. A failed or abandoned Checkout Session never guarantees the engagement.

## 8. Completion, Dispute, and Release

1. The worker marks an in-progress engagement complete.
2. In one database transaction Jale changes the state to `completion_pending`, sets `auto_release_at = now() + interval '48 hours'`, appends an audit event, and emits the completion domain event.
3. The employer can approve before the deadline. Approval atomically creates one durable release command.
4. The employer can dispute before the deadline. Dispute changes the engagement to `disputed` and prevents automatic release.
5. A scheduled Lambda claims due rows with row locking and creates release commands for undisputed engagements.
6. The release worker creates one Stripe Transfer using the charge as `source_transaction` and the worker's connected account as destination.
7. A transfer webhook confirms release and changes the engagement to `released`.
8. A dispute requires the IAM-authorized operator command Lambda. V1 resolution is full release or full refund. An operator dispute refund sets `refund_reason = 'dispute_resolution'`.
9. Cancellation before work starts can trigger a full refund with `refund_reason = 'cancellation'`. Cancellation after work starts uses the dispute path.
10. A card chargeback arriving after `released` does not rewind the engagement state. The webhook processor records the charge dispute on `engagement_payments` (populating `charge_dispute_status` and the unique Stripe dispute ID), raises an alarm, and resolution — transfer reversal or absorbed loss — is an IAM-authorized operator action with an audit row and runbook. V1 does not automate chargeback recovery.

### 8.1 Stale-state expiry

A scheduled sweeper (using the same scheduling infrastructure as automatic release) cancels engagements stuck in `proposed` or `accepted` beyond a configured TTL. The default pilot value is 14 days; the TTL is config-driven, not hardcoded. All such transitions append audit rows with reason codes.

The payment webhook processor handles `checkout.session.expired` by returning a `funding_pending` engagement to `accepted` so the employer can request a new funding Checkout Session. This transition also appends an audit row with a reason code.

## 9. Wallet and Payout Flow

### 9.1 Wallet mode

- Configure the connected account for manual payouts.
- Released funds remain in the worker's Stripe connected-account balance.
- `GET /worker/wallet` retrieves Stripe pending and available balances and combines them with Jale's mirrored history.
- The worker can request a standard payout or, when Stripe reports eligibility and instant-available funds, an instant payout.
- The API never promises instant delivery before Stripe confirms eligibility.
- A safety process warns and then pays out retained US balances before Stripe's two-year manual-payout holding limit.

### 9.2 Direct-deposit mode

- Transfer release still occurs first.
- When Stripe reports the connected funds available, a scheduled command initiates a standard payout to the worker's external bank account.
- Failures remain visible and retryable. Jale does not silently change the worker to wallet mode.

### 9.3 Payout-mode snapshot

The payout mode is copied from `payout_preferences` onto the release/payout command at command-creation time. Subsequent preference changes affect only future releases; they never alter an in-flight command.

### 9.4 Payout state

Stripe payout webhooks are authoritative for `paid` and `failed`. Accounts v2 still emits payout activity through v1 payout events, so the implementation must subscribe to those event types.

## 10. API Surface

### 10.1 Billing

- `GET /employer/billing`
- `POST /employer/billing/checkout`
- `POST /employer/billing/portal`
- `POST /billing/webhook`

### 10.2 Employer engagement actions

- `POST /employer/engagements`
- `GET /employer/engagements`
- `GET /employer/engagements/{engagementId}`
- `POST /employer/engagements/{engagementId}/funding-session`
- `POST /employer/engagements/{engagementId}/approve`
- `POST /employer/engagements/{engagementId}/dispute`

### 10.3 Worker engagement and wallet actions

- `GET /worker/engagements`
- `GET /worker/engagements/{engagementId}`
- `POST /worker/engagements/{engagementId}/accept`
- `POST /worker/engagements/{engagementId}/complete`
- `POST /worker/wallet/onboarding-link`
- `GET /worker/wallet`
- `PUT /worker/wallet/payout-preference`
- `POST /worker/wallet/payouts`

### 10.4 Payment webhook

- `POST /payments/webhook`

Webhook routes are unauthenticated at API Gateway and authenticate exclusively through the endpoint-specific Stripe signature.

### 10.5 Internal engagement contract

All source adapters call one internal domain operation:

```ts
type CreatePaymentEngagementInput = {
  originType: 'job_application';
  originId: string;
  payerUserId: string;
  payeeUserId: string;
  fundingSource: 'external_card';
  amountMinor: number;
  currency: 'usd';
  startDate: string;
  termsSummary: string;
};
```

The operation creates the payment engagement and source binding in one database transaction. Current public handlers construct this input only after validating the employer-owned hired application. A future `GigsStack` extends the origin and funding-source unions through a migration and reviewed adapter; it does not call Stripe or write payment tables directly. There is no unauthenticated or generic public endpoint for this contract.

## 11. Deduplication and Consistency

Use four independent layers.

### 11.1 Client request

Every money-changing endpoint requires an `Idempotency-Key` UUID. Store a canonical request hash. Reusing a key with different parameters returns `409 idempotency_conflict`.

### 11.2 Database business invariant

Use unique constraints and guarded state transitions:

- one `job_payment_engagements` binding per application among engagements that can still proceed or have succeeded (§5.2 partial uniqueness)
- one financial funding identity per engagement
- one transfer per funded payment
- one provider payout per payout command
- `UPDATE ... WHERE state = $expected AND version = $version`
- `SELECT ... FOR UPDATE` for release, dispute, refund, and scheduled claims

### 11.3 Stripe request

Every Stripe mutation gets a deterministic idempotency key. Never generate a new key when retrying the same business operation.

### 11.4 Webhook event

1. Preserve the exact raw request body.
2. Verify the endpoint-specific Stripe signature before parsing or queueing. The raw-body signature verification Lambda has no database access; the `stripe_event_id` insert in step 5 happens in the queue processor, and the verifier must never be granted DB secrets.
3. Send the verified event to an encrypted SQS queue.
4. Return success only after SQS accepts the message.
5. Atomically insert `stripe_event_id`; duplicates become no-ops.
6. Also guard semantic effects using event type, Stripe object ID, current state, and provider timestamps because Stripe can emit distinct Event objects for one object lifecycle.
7. Treat event order as nondeterministic. Fetch the current Stripe object when an older event cannot be safely applied.

## 12. Security Controls

- Separate restricted Stripe keys for `BillingStack` and `MoneyMovementStack`.
- Separate webhook signing secrets for `/billing/webhook` and `/payments/webhook`.
- Store all secrets in AWS Secrets Manager; never place them in CDK context, environment source files, logs, frontend bundles, or test fixtures.
- Keep Stripe client initialization server-side and cache fetched secrets only in Lambda memory.
- Use hosted Checkout, Billing Portal, Connect onboarding, and hosted/embedded payout management where supported.
- Never store card PAN, bank account numbers, debit-card numbers, SSNs, identity documents, or raw KYC payloads.
- Require a recent Cognito `auth_time` for sensitive operations, with pool-specific windows: employers (email/password) require `auth_time` within 15 minutes for funding, approval, and dispute; workers (phone OTP, where each re-auth costs a Twilio SMS) use a session-scoped `auth_time` ceiling of 24 hours for engagement completion, payout-preference changes, and payout creation, compensated by payout destinations being manageable only through Stripe-hosted surfaces. Exact windows are config values, not hardcoded.
- Add API Gateway throttles to all mutation endpoints.
- Validate participant ownership from the database after setting RLS context.
- Use integer minor units and USD only.
- Default pilot maximum: $2,500 per engagement.
- Log provider request IDs, Jale correlation IDs, object IDs, safe error codes, and state transitions. Do not log raw webhook bodies, Checkout URLs, client secrets, tokens, or personal financial data.
- Operator commands require IAM authorization, an explicit reason code, and an audit row.
- Alarms cover webhook verification failures, DLQ depth, stale commands, duplicate/conflict spikes, payout failures, disputes, refunds, chargebacks, and negative-balance signals.

## 13. Frontend and UX

### Employer

- Enable the currently disabled Billing navigation item.
- Billing page shows current plan, active-job usage, allowance, subscription state, and hosted upgrade/manage actions.
- Applicant/job pages show engagement proposal, accepted terms, funding status, payment-guarantee status, completion state, and approve/dispute actions.

### Worker

- Engagement page shows agreed price, terms, funding guarantee, start date, and completion action.
- Wallet page shows pending and available Stripe balances, payout preference, payout history, and standard/instant actions.
- Direct deposit is described as automatic standard payout after funds become available.
- Instant payout UI appears only when Stripe reports eligibility.

All new content is available in English and Spanish. Loading, empty, expired-session, legal-wall, validation, provider-unavailable, and retry-safe states are required.

## 14. Events and Future Integration

`MoneyMovementStack` emits domain events:

- `EngagementAccepted`
- `EngagementFunded`
- `EngagementCompletionSubmitted`
- `EngagementDisputed`
- `EngagementReleased`
- `PayoutPaid`
- `PayoutFailed`

Every engagement event includes `engagement_id`, `origin_type`, the source-binding identifier, `payer_user_id`, `payee_user_id`, currency, amount, state, and correlation ID. Events exclude payment credentials, bank details, identity data, and raw Stripe objects.

No current stack must consume these events. Future email, WhatsApp, analytics, payroll, admin, or Gigs integrations can subscribe without importing payment internals.

A future `GigsStack` owns gig listings, discovery, offers, bookings, and worker-to-worker authorization. After a booking is accepted, its reviewed source adapter creates a bound payment engagement through the internal contract. Card-funded gigs can reuse the existing PaymentIntent and release flow. Connected-balance funding remains disabled until Stripe explicitly approves a supported flow and Jale completes the additional consent, risk, tax, and legal review.

The compatibility promise is bounded rather than zero-change: Jale Gigs adds its own stack, tables, binding table, routes, entitlement keys, and reviewed origin adapter. It extends the allowed origin and funding-source unions through forward-only migrations. It does not replace the payment-engagement table, Stripe webhook processors, command idempotency, completion/dispute/release state machine, connected accounts, payouts, or audit log.

A future payroll/EWA system must not reuse contractor engagement transfers. It may consume shared user and employer identities, but it receives its own provider adapter, legal controls, tax model, and payment lifecycle.

## 15. Stripe Capability Gate

Before implementing `MoneyMovementStack`, run a bounded Stripe sandbox capability spike.

Required proof:

- Jale can create an Accounts v2 connected account with recipient configuration.
- Stripe-hosted onboarding can activate the transfers capability.
- Jale can create a separate charge and transfer it to that connected account.
- Manual standard payouts work through Balance Settings and Payouts APIs.
- Instant-payout eligibility can be queried and a sandbox instant payout can be triggered.
- Required v1 payout webhooks arrive for the Accounts v2 connected account.
- Stripe confirms whether Jale can use funds segregation.

The implementation target is Accounts v2 recipient accounts with a pinned Stripe API version. If Jale's Stripe account cannot use the required recipient or payout capabilities, implementation pauses for a design revision. Do not silently build and maintain both Accounts v1 and v2 adapters.

### 15.1 Phase 0 spike implementation

The capability gate runs as **Phase 0**: an interactive Stripe sandbox setup session followed by local TypeScript spike scripts. No AWS resources are involved.

- Scripts live in `scripts/stripe-spike/` and run with `npx tsx` against the sandbox restricted key.
- The key lives in a gitignored `scripts/stripe-spike/.env`; it is pasted in by the operator and never read, logged, or committed by tooling.
- Webhook delivery is proven with Stripe CLI forwarding (`stripe listen`), not a deployed endpoint.
- Numbered scripts map one-to-one onto the required proofs: product/price creation ($20/mo `employer_pro`), subscription Checkout, Accounts v2 recipient creation, hosted onboarding to active transfers capability, separate charge + transfer with `source_transaction`, manual standard payout, instant-payout eligibility and trigger, and v1 payout/transfer/checkout event arrival for the v2 account.
- Funds-segregation availability is confirmed with Stripe (dashboard or support) as a manual gate item.
- The scripts are throwaway by design but serve as executable reference sequences for Delivery B handlers.

Exit criteria: every script passes and the funds-segregation answer is recorded. Any Accounts v2 recipient or payout capability failure pauses implementation for a design revision before Delivery B.

Funds segregation is optional for the sandbox engineering flow but mandatory for the currently approved production design. Production cannot launch the ordinary platform-balance fallback without an explicit product, finance, and legal design revision.

Wallet-funded subscriptions and wallet-funded gigs are not prerequisites for this capability gate. A later worker-monetization gate must prove Accounts v2 Stripe-balance subscription payments in Jale's sandbox. A separate Jale Gigs funding gate must determine whether Stripe permits the proposed marketplace use of Account Debits or requires Financial Accounts for platforms. It must also address consent, source-fund segregation, refunds, tax reporting, fraud, and negative-balance liability. The current design must not treat a connected-account debit as equivalent to a card-funded allocated PaymentIntent.

## 16. Testing

### Database

- Apply migrations `001` through `035` to a clean PostgreSQL database.
- Test every RLS policy with employer, worker, cross-user, billing-service, and payments-service roles.
- Test immutable funded terms and append-only audit rows.
- Test that job bindings reject a non-hired application, mismatched payer, mismatched payee, duplicate application, and unbound or unsupported origins.
- Test engagement participant RLS using payer/payee IDs rather than `users.user_type`.
- Test unique constraints under concurrent transactions.
- Test that re-proposing an engagement after a cancelled, funding-failed, or cancellation-refunded one succeeds, while a released or dispute-refunded one still blocks a new proposal.

### Lambda and domain

- Test every allowed and forbidden state transition.
- Test request-key reuse with identical and conflicting bodies.
- Test duplicate and out-of-order webhook events.
- Test a Lambda timeout after Stripe succeeds but before Jale records the response.
- Test SQS replay, partial failure, DLQ redrive, stale command reconciliation, and provider 429/5xx behavior.
- Test concurrent employer approval, employer dispute, and automatic release.
- Test transfer failure, payout failure, refund, and chargeback handling.
- Test authorization and recent-authentication requirements.
- Test that the internal engagement operation atomically creates the core row and job binding and rolls both back on failure.
- Test that current public employer routes reject a worker acting as payer even though the core schema is role-neutral.
- Test that engagement events carry source-binding and payer/payee metadata without financial credentials or raw provider objects.
- Test that a payout-preference change between release and payout sweep does not alter an in-flight payment command.
- Test that a `checkout.session.expired` webhook returns a `funding_pending` engagement to `accepted`.
- Test that a post-release chargeback records dispute status on `engagement_payments` without rewinding the engagement state.

### CDK

- Assert routes and authorizers for each stack.
- Assert unauthenticated webhook routes have signature secrets but no Cognito authorizer.
- Assert separate queues, DLQs, encryption, alarms, security groups, database secrets, and restricted secret grants.
- Assert `BillingStack` and `MoneyMovementStack` do not import one another.
- Assert there is no generic public engagement-creation route and no `GigsStack` resource in this release.

### Stripe sandbox

- Subscription Checkout to active entitlement.
- Billing Portal session.
- Accounts v2 recipient onboarding.
- Employer engagement funding.
- Duplicate funding request replay.
- Worker completion and employer approval.
- Worker completion and timed automatic release.
- Dispute and operator full refund.
- Wallet retention and standard payout.
- Direct-deposit automatic payout.
- Eligible instant payout.
- Duplicate, delayed, and out-of-order webhook delivery.

### Frontend

- Employer billing and engagement panels.
- Worker engagement and wallet pages.
- English and Spanish.
- Mobile and desktop widths.
- Hosted redirect return, refresh, session expiry, legal wall, loading, empty, provider error, and retry states.

## 17. Delivery Sequence

Planning decision (2026-07-01): Phase 0 (Stripe sandbox setup and capability spike, §15.1) runs first as a short interactive session. Deliveries A and B are planned together in one implementation plan but executed sequentially — A completes its review gate before B starts, so B copies A's proven webhook-inbox, service-role, security-group, and restricted-key patterns. Delivery C is planned separately after B's review gate.

### Phase 0: Stripe sandbox setup and capability spike

- Stripe sandbox account setup, Connect enablement, Accounts v2 confirmation
- `scripts/stripe-spike/` local proof scripts (§15.1)
- $20/mo `employer_pro` Product and Price creation; price ID recorded for configuration
- Funds-segregation availability answer recorded

### Delivery A: Billing foundation

- Migration `034`
- Billing service role and secret
- `BillingStack`
- Subscription webhook inbox/processor
- Entitlement helper and job-posting enforcement
- Employer billing page
- Stripe sandbox subscription acceptance

### Delivery B: Money-movement foundation

- Stripe capability spike
- Migration `035`
- Payments service role and secret
- `MoneyMovementStack`
- Connected-account onboarding
- Generic payment-engagement core and `job_payment_engagements` source binding
- Employer-job engagement proposal/acceptance
- Funding Checkout and webhook reconciliation

### Delivery C: Release and payouts

- Completion, approval, dispute, automatic-release scheduler
- Transfer and refund commands
- Wallet balance and payout preference
- Standard, automatic direct-deposit, and eligible instant payouts
- Operator command Lambda and runbook
- Full sandbox acceptance suite

Each delivery has its own detailed implementation plan and review gate.

## 18. Go-Live Gates

Sandbox completion does not authorize production deployment.

Production requires:

- Stripe approval for the Connect configuration and funds segregation
- Marketplace-payment legal review
- Contractor-classification review
- Federal and state tax-reporting determination
- Approved refund, dispute, cancellation, and abandoned-balance policies
- Updated Terms of Service and Privacy Policy
- Financial acceptance of processing fees, refunds, chargebacks, disputes, and negative balances
- Funded platform reserve policy
- Exercised freeze, refund, release, reconciliation, secret-rotation, DLQ, and incident runbooks
- Passing sandbox acceptance suite
- Explicit operator approval for AWS deployment and live Stripe credentials

## 19. Out of Scope

- Live-money deployment
- Worker paid subscription checkout or Stripe-balance subscription payment
- Payroll, tax withholding, wage statements, or earned-wage access
- Hourly timecards, variable final amounts, milestones, tips, bonuses, or partial settlements
- Multi-currency or non-US connected accounts
- Jale-managed bank/card collection
- A self-managed wallet ledger
- Jale Gigs implementation, connected-balance gig funding, or unscoped peer-to-peer transfers
- Worker spending cards
- Automated dispute adjudication
- Notification delivery implementation
- Admin-console UI integration

## 20. Primary Research Sources

- [Stripe Connect overview](https://docs.stripe.com/connect)
- [Accounts v2 and recipient configuration](https://docs.stripe.com/connect/accounts-v2)
- [Create a marketplace connected account](https://docs.stripe.com/connect/marketplace/tasks/create)
- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Funds segregation private preview](https://docs.stripe.com/connect/funds-segregation)
- [Connect charge, refund, and dispute responsibility](https://docs.stripe.com/connect/charges)
- [Manual payouts and holding limits](https://docs.stripe.com/connect/manual-payouts)
- [Instant payouts](https://docs.stripe.com/connect/instant-payouts)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe webhook security and duplicate handling](https://docs.stripe.com/webhooks?lang=node)
- [Stripe API key security](https://docs.stripe.com/keys)
- [Stripe balance subscription payments](https://docs.stripe.com/payments/pay-with-balance)
- [Stripe connected-account debits](https://docs.stripe.com/connect/account-debits)
- [Stripe Financial Accounts outbound payments](https://docs.stripe.com/treasury/moving-money/moving-money-out-of-financial-accounts)
- [IRS worker classification guidance](https://www.irs.gov/businesses/small-businesses-self-employed/independent-contractor-self-employed-or-employee)

This document is an engineering design, not legal or tax advice.
