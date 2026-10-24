/**
 * Billing webhook processor Lambda.
 *
 * SQS consumer (batch size 1). Runs as jale_billing service role.
 * Processes Stripe v1 snapshot events from the billing webhook queue.
 *
 * Processing lifecycle:
 *  1. Claim inbox row by stripe_event_id (INSERT ON CONFLICT, then a single
 *     atomic lease-guarded UPDATE if the row pre-existed).
 *     - processed/skipped → terminal duplicate no-op.
 *     - failed/lease-expired received → resumable: increment attempt_count,
 *       take a fresh lease.
 *     - received/failed row with a LIVE (unexpired) lease → a concurrent
 *       delivery is already in flight; not a terminal duplicate, but not
 *       resumable either — let SQS redeliver later.
 *  2. Persist claim/attempt state in a short transaction.
 *  3. Fetch authoritative Stripe state OUTSIDE any DB transaction.
 *  4. Mirror subscription state + mark processed (clearing the lease) in a
 *     final transaction. That transaction can instead end in 'skipped' when
 *     the event turns out to concern a subscription that is NOT the user's
 *     current one — see the decision table in handleSubscriptionEvent.
 *
 * Lease semantics guard against duplicate SQS delivery of the same Stripe
 * event running two concurrent processor invocations (maxConcurrency 3):
 * the lease is set strictly longer than the Lambda timeout, so a live
 * invocation always holds an unexpired lease and a duplicate delivery sees
 * the row as in-progress rather than resumable.
 *
 * Runs as jale_billing which has:
 *   SELECT billing_plans, billing_customers
 *   SELECT/INSERT/UPDATE subscriptions, billing_webhook_events
 *   EXECUTE on the company enforcer functions (migration 128)
 *   EXECUTE on jale_cap.org_member_access (migration 134)
 *   NO users-table access — correlate via billing_customers.provider_customer_id
 *
 * Cognito follows billing (Phase 3): after an enforce that suspended foremen
 * or revoked invites, or a restore that restored foremen, the employer pool
 * is made to match org_member_access after COMMIT (EMPLOYER_USER_POOL_ID).
 *
 * A company pays one subscription (Phase 2): a customer maps to its company
 * through billing_customers.organization_id (127), never through Stripe
 * metadata, so customers created before Phase 2 map like new ones.
 */
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import Stripe = require('stripe');
import { getDbPool } from '../lib/db';
import { getStripe, getStripeSecret } from '../lib/stripe-client';
import { resolveCompanyEntitlements } from '../lib/entitlements';
import { queueEmail } from '../lib/email-outbox';
import { renderBillingPauseEmail } from '../lib/billing-pause-template';
import { renderBillingResumeEmail } from '../lib/billing-resume-template';
import { applyMemberAccess, type MemberAccessChange } from '../lib/member-access';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEnvelope {
  eventId: string;
  eventType: string;
  receivedAt: string;
  rawBody: string; // base64-encoded raw bytes of the Stripe event
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Inbox claim lease duration. The processor Lambda's timeout is 60s (see
 * `timeout: 60` on BillingProcessorLambda in lib/stacks/billing-stack.ts).
 * Five minutes is well above that with generous margin, so a live
 * invocation's lease never expires mid-processing, while a genuinely
 * abandoned claim (crashed/killed invocation) becomes resumable again soon
 * after.
 */
const INBOX_LEASE_MS = 5 * 60 * 1000;

/**
 * The statuses excluded from the partial unique index
 * subscriptions_one_current_per_organization (migration 127; 034's
 * per-user index of the same shape before it):
 *
 *   CREATE UNIQUE INDEX subscriptions_one_current_per_organization
 *       ON subscriptions (organization_id)
 *    WHERE status NOT IN ('canceled', 'incomplete_expired');
 *
 * A row in one of these statuses does NOT occupy the company's single
 * "current subscription" slot.
 *
 * Deliberately NOT the same set as `reducingStatuses` in
 * handleSubscriptionEvent: that one drives the company's job- and
 * seat-limit enforcement and invite revocation, and also lists 'unpaid' and
 * 'paused', both of which this index still counts as current. Do not merge the two — they answer different questions.
 */
const TERMINAL_SUBSCRIPTION_STATUSES: readonly string[] = ['canceled', 'incomplete_expired'];

/**
 * Event types that, by construction, concern the NEWEST subscription a user
 * has at the moment they arrive — and are therefore the only ones allowed to
 * retire that user's other current subscription rows.
 *
 * Everything else (updated / paused / resumed / invoice.*) can just as easily
 * describe a stale subscription that Stripe is still dunning, so it gets no
 * such authority. See the decision table in handleSubscriptionEvent.
 */
const SUPERSEDING_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a string Stripe object ID from an event object.
 * Stripe event data.object has `id` field.
 */
function getObjectId(event: Stripe.Event): string | undefined {
  const obj = event.data?.object as unknown as Record<string, unknown> | undefined;
  return typeof obj?.id === 'string' ? obj.id : undefined;
}

/**
 * Parse the subscription ID from a Stripe Invoice using the pinned
 * 2026-06-24.dahlia contract.
 *
 * On this API version: invoice.parent.type === 'subscription_details'
 * and subscription comes from invoice.parent.subscription_details.subscription.
 * invoice.subscription does NOT exist on this API version.
 */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const parent = invoice.parent;
  if (!parent) return undefined;
  if (parent.type !== 'subscription_details') return undefined;
  const sub = parent.subscription_details?.subscription;
  if (!sub) return undefined;
  if (typeof sub === 'string') return sub;
  // Expanded object
  if (typeof sub === 'object' && sub !== null && typeof (sub as Stripe.Subscription).id === 'string') {
    return (sub as Stripe.Subscription).id;
  }
  return undefined;
}

/**
 * Extract current_period_start and current_period_end from the first
 * subscription item. Per the pinned API, period fields live on the
 * subscription item (Stripe.SubscriptionItem), not on the subscription root.
 */
function getSubscriptionPeriod(subscription: Stripe.Subscription): {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
} {
  const item = subscription.items?.data?.[0];
  if (!item) return { currentPeriodStart: null, currentPeriodEnd: null };
  const start = (item as Stripe.SubscriptionItem).current_period_start;
  const end = (item as Stripe.SubscriptionItem).current_period_end;
  return {
    currentPeriodStart: typeof start === 'number' ? new Date(start * 1000) : null,
    currentPeriodEnd: typeof end === 'number' ? new Date(end * 1000) : null,
  };
}

// ── Core processor logic (exported for unit tests) ────────────────────────────

export interface ProcessResult {
  outcome: 'processed' | 'skipped' | 'failed' | 'duplicate_terminal' | 'duplicate_in_progress';
  errorCode?: string;
}

export interface ProcessOptions {
  /**
   * Epoch ms after which no Cognito call is made (member-access DEADLINE):
   * the handler passes `Date.now() + context.getRemainingTimeInMillis() - 5000`.
   */
  deadlineAt?: number;
}

export async function processEnvelope(envelope: WebhookEnvelope, options: ProcessOptions = {}): Promise<ProcessResult> {
  const { eventId, eventType } = envelope;

  // Decode and parse the raw body to get the full event object
  let stripeEvent: Stripe.Event;
  try {
    const rawJson = Buffer.from(envelope.rawBody, 'base64').toString('utf8');
    stripeEvent = JSON.parse(rawJson) as Stripe.Event;
  } catch {
    // Malformed body — persist failure and return
    await persistInboxFailure(eventId, eventType, undefined, 'malformed_envelope', false);
    return { outcome: 'failed', errorCode: 'malformed_envelope' };
  }

  const objectId = getObjectId(stripeEvent);

  // ── Step 1: Claim / resume inbox row ────────────────────────────────────
  const claimResult = await claimInboxRow(eventId, eventType, objectId);
  if (claimResult.terminalDuplicate) {
    return { outcome: 'duplicate_terminal' };
  }
  if (claimResult.inProgressDuplicate) {
    // A concurrent delivery already holds a live lease on this event. Do not
    // touch the row (that would race with the in-flight owner) — just bail
    // out and let SQS redeliver later.
    return { outcome: 'duplicate_in_progress' };
  }

  // ── Step 2: Dispatch by event type ────────────────────────────────────
  const knownSubscriptionEvents = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    // paused/resumed are mirrored, not skipped: the handler already routes
    // every 'customer.subscription.*' type through the mirror path, and
    // reducingStatuses below already lists 'paused'. Omitting them here made
    // them fall through to a SILENT 'skipped', so a paused subscription kept
    // its Pro entitlements until some unrelated event happened to arrive.
    'customer.subscription.paused',
    'customer.subscription.resumed',
    // Known, but deliberately not mirrored — see the explicit skip below.
    'customer.subscription.trial_will_end',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
    'invoice.finalized',
  ]);

  if (!knownSubscriptionEvents.has(eventType)) {
    // Unknown event type → mark skipped
    await markInboxStatus(eventId, 'skipped', null, null);
    return { outcome: 'skipped' };
  }

  // invoice.finalized is a known type but we explicitly skip it
  if (eventType === 'invoice.finalized') {
    await markInboxStatus(eventId, 'skipped', null, null);
    return { outcome: 'skipped' };
  }

  // trial_will_end carries no state worth mirroring (the subscription is
  // still trialing; the status change arrives as its own event), so it is
  // skipped like invoice.finalized — but unlike invoice.finalized it is
  // ALARMED. BillingStack greps this literal out of this Lambda's log group
  // into the Jale/Billing BillingKnownEventSkipped metric + alarm; keep the
  // string in sync. The asymmetry is deliberate: invoice.finalized fires on
  // every single invoice, so alarming on it would leave the alarm
  // permanently breached, whereas trial_will_end cannot occur until someone
  // configures a trial price — at which point we DO want to be told that a
  // billing lifecycle event is being dropped on the floor.
  if (eventType === 'customer.subscription.trial_will_end') {
    await markInboxStatus(eventId, 'skipped', null, null);
    console.warn('billing_event_skipped_known', { eventType });
    return { outcome: 'skipped' };
  }

  try {
    const result = await handleSubscriptionEvent(stripeEvent, eventId, eventType, options);
    return result;
  } catch (err) {
    const code = err instanceof Error ? err.message : 'unknown_processor_error';
    await markInboxStatus(eventId, 'failed', code, null);
    return { outcome: 'failed', errorCode: code };
  }
}

// ── Subscription event handler ────────────────────────────────────────────────

async function handleSubscriptionEvent(
  stripeEvent: Stripe.Event,
  eventId: string,
  eventType: string,
  options: ProcessOptions,
): Promise<ProcessResult> {
  let subscriptionId: string | undefined;

  // Extract subscription ID from the event
  if (eventType === 'checkout.session.completed') {
    const session = stripeEvent.data.object as Stripe.Checkout.Session;
    const sub = session.subscription;
    subscriptionId = typeof sub === 'string' ? sub : typeof sub === 'object' && sub !== null ? (sub as Stripe.Subscription).id : undefined;
    if (!subscriptionId) {
      // checkout.session.completed without subscription (e.g., payment mode) — skip
      await markInboxStatus(eventId, 'skipped', null, null);
      return { outcome: 'skipped' };
    }
  } else if (eventType.startsWith('customer.subscription.')) {
    const sub = stripeEvent.data.object as Stripe.Subscription;
    subscriptionId = sub.id;
  } else if (eventType.startsWith('invoice.')) {
    // Parse using pinned dahlia contract
    const invoice = stripeEvent.data.object as Stripe.Invoice;
    subscriptionId = getInvoiceSubscriptionId(invoice);
    if (!subscriptionId) {
      // Known invoice event without resolvable subscription ID = retryable failure
      await markInboxStatus(eventId, 'failed', 'invoice_subscription_id_missing', null);
      return { outcome: 'failed', errorCode: 'invoice_subscription_id_missing' };
    }
  }

  if (!subscriptionId) {
    await markInboxStatus(eventId, 'failed', 'subscription_id_missing', null);
    return { outcome: 'failed', errorCode: 'subscription_id_missing' };
  }

  // ── Step 3: Fetch authoritative Stripe state OUTSIDE any transaction ──
  const stripe = await getStripe();
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch {
    // Stripe timeout or error — retryable; always return a safe, stable error code
    await markInboxStatus(eventId, 'failed', 'stripe_fetch_failed', null);
    return { outcome: 'failed', errorCode: 'stripe_fetch_failed' };
  }

  // ── Step 4: Validate customer correlation and price ───────────────────
  const stripeSecret = await getStripeSecret();
  const priceIdEmployerPro = stripeSecret.priceIdEmployerPro;
  if (!priceIdEmployerPro) {
    await markInboxStatus(eventId, 'failed', 'billing_configuration_invalid', null);
    return { outcome: 'failed', errorCode: 'billing_configuration_invalid' };
  }

  // Correlate customer
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer as Stripe.Customer)?.id;

  if (!customerId) {
    await markInboxStatus(eventId, 'failed', 'customer_id_missing', null);
    return { outcome: 'failed', errorCode: 'customer_id_missing' };
  }

  // The payer and their company, via billing_customers. A customer created
  // before Phase 2 (its Stripe metadata names only userId) maps the same
  // way: 127 back-filled organization_id from the payer's company.
  const pool = await getDbPool();
  const customerRes = await pool.query<{ user_id: string; organization_id: string | null }>(
    'SELECT user_id, organization_id FROM billing_customers WHERE provider_customer_id = $1',
    [customerId],
  );
  if (customerRes.rows.length === 0) {
    // Terminal skip — NOT a retryable failure.
    //
    // A Stripe customer with no billing_customers row is permanently
    // unactionable: the mapping row is committed BEFORE any Stripe Checkout
    // session for that customer can exist (lambda/billing/checkout.ts →
    // persistBillingCustomer COMMITs before stripe.checkout.sessions.create),
    // and a mapping, once written, cannot go away: the users FK is ON DELETE
    // RESTRICT and migration 034 grants no role DELETE on billing_customers.
    // So a customer we already know can never regress to unknown. The residual
    // unknowns are dashboard-created, test-mode, or orphaned (the losing side
    // of a concurrent checkout) customers. Marking them
    // 'failed' only burned 3 SQS receives per event and pushed them into the
    // DLQ, firing BillingWebhookDlqDepth for something no redrive can fix.
    //
    // 'skipped' is terminal at BOTH levels, which is what makes this safe:
    //   - row:     claimInboxRow reports terminalDuplicate for 'skipped', and
    //              persistInboxFailure's WHERE excludes it, so a redelivery or
    //              a corrupted body can never reopen the row.
    //   - message: processSqsRecord does not throw on 'skipped', so with
    //              reportBatchItemFailures the void return reports no failed
    //              items and SQS deletes the message.
    // Only this branch is special-cased; the throw site in processSqsRecord
    // must stay generic, since suppressing the throw there would delete the
    // message while leaving a resumable 'failed' row behind.
    //
    // Two deliberate deviations from every other 'skipped' write here (which
    // pass null/null), both for forensics rather than for control flow:
    //   - last_error_code is non-null on a 'skipped' row for the first time,
    //     so the reason stays recoverable from the inbox itself.
    //   - processed_at is non-null on a 'skipped' row for the first time: it
    //     records WHEN we terminally decided, not that we mirrored any state.
    // markInboxStatus already accepts both, the CHECK constraint (migration
    // 034) only constrains processing_status, and nothing outside this Lambda
    // reads billing_webhook_events, so no consumer can be surprised.
    await markInboxStatus(eventId, 'skipped', 'unknown_customer', new Date());
    // Because the skip is otherwise completely silent (no DLQ, no alarm, no
    // reader of the inbox table), this literal is the only signal. BillingStack
    // greps it out of this Lambda's log group into the Jale/Billing
    // BillingUnknownCustomerSkipped metric + alarm — keep the string in sync.
    console.warn(JSON.stringify({ metric: 'billing_unknown_customer_skipped', eventId }));
    return { outcome: 'skipped', errorCode: 'unknown_customer' };
  }
  const userId: string = String(customerRes.rows[0].user_id);
  const organizationId = customerRes.rows[0].organization_id ? String(customerRes.rows[0].organization_id) : null;
  if (!organizationId) {
    // Only possible before migration 127 makes the column NOT NULL. Retryable:
    // the redelivered event maps once 127 is applied (Release runbook).
    await markInboxStatus(eventId, 'failed', 'billing_customer_organization_missing', null);
    return { outcome: 'failed', errorCode: 'billing_customer_organization_missing' };
  }

  // Verify the subscription item price equals the configured priceIdEmployerPro
  const firstItem = subscription.items?.data?.[0];
  const priceId = firstItem?.price?.id;
  if (priceId !== priceIdEmployerPro) {
    await markInboxStatus(eventId, 'failed', 'unknown_price', null);
    return { outcome: 'failed', errorCode: 'unknown_price' };
  }
  const planCode = 'employer_pro';

  // ── Step 5: Mirror subscription state in a final transaction ──────────
  const { currentPeriodStart, currentPeriodEnd } = getSubscriptionPeriod(subscription);
  const status = subscription.status;
  const providerSubId = subscription.id;
  const cancelAtPeriodEnd = subscription.cancel_at_period_end ?? false;

  // Phase 3: the Cognito state the company's foremen should have, read inside
  // the transaction after an enforce or a restore changed it, applied after
  // COMMIT with the client released (see convergeMemberAccess).
  let memberAccess: MemberAccessChange[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialise every webhook for this company, first thing in the
    // transaction and before the company's plan is read. Without it a
    // redelivered 'canceled' for an old subscription and a 'created' for the
    // new one can each read the plan before the other commits, and enforce
    // Free limits on a paying company. An advisory lock because jale_billing
    // cannot lock organizations or billing_customers; keyed on the company id
    // from billing_customers (never a user id), released at COMMIT/ROLLBACK.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('billing-org:' || $1::uuid::text, 0))",
      [organizationId],
    );

    // Fetch existing subscription row for grace logic
    const existingRes = await client.query(
      `SELECT id, status, grace_ends_at FROM subscriptions
        WHERE provider_subscription_id = $1
        FOR UPDATE`,
      [providerSubId],
    );
    const existing = existingRes.rows[0];

    // Build grace_ends_at parameter ($8):
    // - past_due + existing deadline → preserve (literal timestamp passed; SQL CASE keeps it)
    // - past_due + no existing deadline → null (SQL CASE sets now()+7d)
    // - non-past_due → null (SQL CASE clears to NULL)
    const graceFragment = status === 'past_due' && existing?.status === 'past_due' && existing?.grace_ends_at
      ? existing.grace_ends_at  // preserve — use literal timestamp
      : null;

    // ── Which subscription is this user's CURRENT one? ───────────────────
    //
    // subscriptions_one_current_per_organization (migration 127) lets a
    // company hold exactly one row whose status is not
    // 'canceled'/'incomplete_expired'. (Read "user" below as "company".)
    // The upsert below conflicts on (provider_subscription_id), so when a
    // SECOND provider_subscription_id shows up for a user who still has a
    // current row, that target does not match, the statement INSERTs, and it
    // trips the partial index with a 23505.
    //
    // Two live subscriptions is a REACHABLE steady state, not merely a race.
    // The checkout guard (lambda/lib/billing-operations.ts) only refuses a
    // new Checkout Session while the existing subscription is active,
    // trialing, or past_due within grace. A user whose subscription is
    // unpaid, paused, incomplete, or past_due beyond grace can legitimately
    // subscribe again, and Stripe then keeps BOTH alive: dunning goes on
    // emitting invoice.payment_failed / customer.subscription.updated for the
    // OLD one for weeks.
    //
    // So "is this row the current one?" cannot be answered from status alone
    // — it needs recency, and the only recency signal available here without
    // extra Stripe calls is the EVENT TYPE. checkout.session.completed and
    // customer.subscription.created are, by construction, about the newest
    // subscription for that user at the moment they arrive. Every other type
    // is just as likely to concern a stale one. Hence:
    //
    //   incoming status terminal   → upsert as before. A terminal row sits
    //                                outside the partial index, so it can
    //                                neither collide nor need to retire
    //                                anything.
    //   no other current row       → upsert as before.
    //   created / checkout done    → newest by construction: retire the
    //                                others, then upsert.
    //   any other type, others     → this event is about a subscription that
    //   exist                        is NOT the user's current one. Upserting
    //                                would 23505; retiring the others would
    //                                strip a PAYING employer down to free
    //                                entitlements and then pause their jobs.
    //                                Neither is acceptable, so skip it.
    //
    // Superseded rows deliberately do NOT trigger
    // billing_enforce_org_limits — enforcement stays decided by the
    // incoming subscription's own status below, exactly as before.
    //
    // Concurrency: two invocations for one company serialise on the company
    // advisory lock taken after BEGIN, so the second reads what the first
    // committed. Anything that still aborts a transaction here (a 40P01 or a
    // 23505) is self-healing: it marks that inbox row failed and SQS
    // redelivers it, by which time the committed state sends the retry down
    // the right branch.
    if (!TERMINAL_SUBSCRIPTION_STATUSES.includes(status)) {
      // Terminal incoming statuses skip this read altogether: same outcome as
      // reading it and ignoring the result, minus the locks.
      //
      // IS DISTINCT FROM, not <>: provider_subscription_id is nullable
      // (migration 034), and a NULL-valued row still occupies the slot while
      // a <> comparison against it evaluates to NULL and would miss it.
      const othersRes = await client.query<{ id: string; provider_subscription_id: string | null }>(
        `SELECT id, provider_subscription_id FROM subscriptions
          WHERE organization_id = $1
            AND provider_subscription_id IS DISTINCT FROM $2
            AND status NOT IN ('canceled', 'incomplete_expired')
          ORDER BY updated_at DESC
          FOR UPDATE`,
        [organizationId, providerSubId],
      );
      const others = othersRes.rows;

      if (others.length > 0 && SUPERSEDING_EVENT_TYPES.has(eventType)) {
        // Retire by primary key: the SELECT above already locked exactly
        // these rows in this transaction, so re-checking status here would
        // be redundant.
        await client.query(
          `UPDATE subscriptions
              SET status               = 'canceled',
                  cancel_at_period_end = false,
                  grace_ends_at        = NULL,
                  updated_at           = now()
            WHERE id = ANY($1::uuid[])`,
          [others.map((row) => row.id)],
        );
        // No PII: internal user id and Stripe subscription ids only.
        console.info('superseded_prior_subscription', {
          userId,
          organizationId,
          supersededCount: others.length,
          newProviderSubId: providerSubId,
        });
      } else if (others.length > 0) {
        // This also skips an out-of-order 'updated' that arrives before its
        // own creation event — harmless, since the creation event does the
        // superseding and later events refresh the row. The stale row heals
        // itself as well: once Stripe terminalizes the old subscription, the
        // incoming status is terminal and the branch above upserts it.
        //
        // BillingStack greps this literal out of this Lambda's log group into
        // the Jale/Billing BillingKnownEventSkipped metric; keep it in sync.
        console.warn('billing_superseded_subscription_event', {
          userId,
          organizationId,
          eventType,
          providerSubId,
          currentProviderSubId: others[0].provider_subscription_id,
        });
        await markInboxStatusWithClient(client, eventId, 'skipped', 'superseded_subscription', null);
        await client.query('COMMIT');
        return { outcome: 'skipped' };
      }
    }

    const upsertRes = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (
          user_id, plan_code, provider_subscription_id, status,
          current_period_start, current_period_end, cancel_at_period_end,
          grace_ends_at, updated_at, organization_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $4 = 'past_due' AND $8::timestamptz IS NULL
               THEN now() + interval '7 days'
               ELSE $8::timestamptz
          END,
          now(), $9)
       ON CONFLICT (provider_subscription_id)
         DO UPDATE SET
           status               = EXCLUDED.status,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end   = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           grace_ends_at        = CASE
             WHEN EXCLUDED.status = 'past_due' AND subscriptions.status = 'past_due' AND subscriptions.grace_ends_at IS NOT NULL
               THEN subscriptions.grace_ends_at        -- preserve existing deadline
             WHEN EXCLUDED.status = 'past_due'
               THEN EXCLUDED.grace_ends_at             -- new deadline (now+7d)
             ELSE NULL                                 -- non-past_due: clear
           END,
           updated_at           = now()
       RETURNING id`,
      [
        userId,
        planCode,
        providerSubId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        graceFragment,
        organizationId,
      ],
    );

    const persistedSubscriptionId = upsertRes.rows[0]?.id ?? existing?.id;
    const reducingStatuses = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
    if (reducingStatuses.has(status)) {
      if (!persistedSubscriptionId) throw new Error('subscription_upsert_missing_id');
      // Phase 2: the company's plan, enforced across the company (128):
      // foremen over the seat limit are suspended first (most recently
      // joined first), then jobs over the job limit pause (a suspended or
      // inactive member's jobs before active members', each oldest kept
      // first), and the newest live invites over the seats left are
      // revoked. Idempotent, so a repeated event changes nothing and mails
      // nothing.
      const entitlements = await resolveCompanyEntitlements(client, organizationId);
      const enforcement = await client.query<{
        paused_count: number;
        paused_titles: string[];
        suspended_count: number;
        suspended_emails: string[];
        revoked_invite_count: number;
        owner_email: string | null;
      }>(
        `SELECT paused_count, paused_titles, suspended_count, suspended_emails, revoked_invite_count, owner_email
           FROM jale_billing_internal.billing_enforce_org_limits($1, $2, $3)`,
        [organizationId, entitlements.activeJobLimit, entitlements.foremanSeatLimit],
      );
      const result = enforcement.rows[0];
      if (!result) throw new Error('billing_job_enforcement_invalid_result');
      const pausedCount = Number(result.paused_count);
      const suspendedCount = Number(result.suspended_count);
      const revokedInvites = Number(result.revoked_invite_count);
      if (![pausedCount, suspendedCount, revokedInvites].every((n) => Number.isInteger(n) && n >= 0)) {
        throw new Error('billing_job_enforcement_invalid_result');
      }
      if (pausedCount > 0 || suspendedCount > 0) {
        if (typeof result.owner_email !== 'string'
          || result.owner_email.length > 320
          || !result.owner_email.includes('@')) {
          throw new Error('billing_job_enforcement_invalid_email');
        }
        const titles = Array.isArray(result.paused_titles) ? result.paused_titles : [];
        if (titles.length !== pausedCount
          || titles.some((title) => typeof title !== 'string' || title.trim().length === 0)) {
          throw new Error('billing_job_enforcement_invalid_titles');
        }
        const members = Array.isArray(result.suspended_emails) ? result.suspended_emails : [];
        if (members.length !== suspendedCount
          || members.some((member) => typeof member !== 'string' || member.trim().length === 0)) {
          throw new Error('billing_seat_enforcement_invalid_members');
        }
        console.info('enforced_company_limits', { organizationId, pausedCount, suspendedCount, revokedInvites });
        const origin = (process.env.ALLOWED_ORIGIN ?? '').replace(/\/$/, '');
        if (!origin) throw new Error('billing_allowed_origin_missing');
        const rendered = renderBillingPauseEmail({
          pausedTitles: titles,
          suspendedMembers: members,
          englishBillingUrl: `${origin}/en/employer/billing`,
          spanishBillingUrl: `${origin}/es/employer/billing`,
        });
        await queueEmail(client, {
          recipientEmail: result.owner_email,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          sourceType: 'billing_pause',
          sourceId: persistedSubscriptionId,
          idempotencyKey: `billing-pause:${persistedSubscriptionId}:${eventId}`,
        });
      } else if (revokedInvites > 0) {
        console.info('enforced_company_limits', { organizationId, pausedCount, suspendedCount, revokedInvites });
      }
      // A suspended foreman must lose their sign-in. A revoked invite matters
      // too: a removed member whose re-invite was enabled at send (Deviation
      // 1) is disabled again once the enforcer revokes that invite.
      if (suspendedCount > 0 || revokedInvites > 0) {
        memberAccess = await readMemberAccess(client, organizationId);
      }
    }

    // Sprint 28 (K4.5), per company since Phase 2: an entitled subscription
    // first restores the earliest suspended foremen into the seats left, then
    // brings back the jobs billing paused (only those: billing_paused_at marks
    // them; an employer's own status change clears the mark), oldest first, up
    // to the resolved limit. Same transaction as the upsert, so a rollback
    // undoes all of it, and one email per event, keyed like the pause notice.
    if (RESUMING_STATUSES.has(status)) {
      const entitlements = await resolveCompanyEntitlements(client, organizationId);
      const resumeRes = await client.query<{
        resumed_count: number;
        resumed_titles: string[];
        restored_count: number;
        restored_emails: string[];
        owner_email: string | null;
      }>(
        `SELECT resumed_count, resumed_titles, restored_count, restored_emails, owner_email
           FROM jale_billing_internal.billing_restore_org($1, $2, $3)`,
        [organizationId, entitlements.activeJobLimit, entitlements.foremanSeatLimit],
      );
      const resumed = resumeRes.rows[0];
      if (!resumed) throw new Error('billing_job_resume_invalid_result');
      const resumedCount = Number(resumed.resumed_count);
      const restoredCount = Number(resumed.restored_count);
      if (![resumedCount, restoredCount].every((n) => Number.isInteger(n) && n >= 0)) {
        throw new Error('billing_job_resume_invalid_result');
      }
      if (restoredCount > 0) {
        console.info('restored_company_members', { organizationId, restoredCount });
        memberAccess = await readMemberAccess(client, organizationId);
      }
      if (resumedCount > 0) {
        if (!persistedSubscriptionId) throw new Error('subscription_upsert_missing_id');
        if (typeof resumed.owner_email !== 'string'
          || resumed.owner_email.length > 320
          || !resumed.owner_email.includes('@')) {
          throw new Error('billing_job_resume_invalid_email');
        }
        const titles = Array.isArray(resumed.resumed_titles) ? resumed.resumed_titles : [];
        if (titles.length !== resumedCount
          || titles.some((title) => typeof title !== 'string' || title.trim().length === 0)) {
          throw new Error('billing_job_resume_invalid_titles');
        }
        console.info('resumed_paused_jobs', { organizationId, resumedCount });
        const origin = (process.env.ALLOWED_ORIGIN ?? '').replace(/\/$/, '');
        if (!origin) throw new Error('billing_allowed_origin_missing');
        const rendered = renderBillingResumeEmail({
          resumedTitles: titles,
          englishJobsUrl: `${origin}/en/employer/jobs`,
          spanishJobsUrl: `${origin}/es/employer/jobs`,
        });
        await queueEmail(client, {
          recipientEmail: resumed.owner_email,
          subject: rendered.subject,
          bodyText: rendered.bodyText,
          bodyHtml: rendered.bodyHtml,
          sourceType: 'billing_resume',
          sourceId: persistedSubscriptionId,
          idempotencyKey: `billing-resume:${persistedSubscriptionId}:${eventId}`,
        });
      }
    }

    await markInboxStatusWithClient(client, eventId, 'processed', null, new Date());
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Committed and released: from here on nothing may turn the event into a
  // failure, since a redelivery would find it processed and never retry.
  await convergeMemberAccess(memberAccess, { organizationId, eventId, deadlineAt: options.deadlineAt });
  return { outcome: 'processed' };
}

/** Statuses that entitle the employer again, so billing's paused jobs come back (K4.5). */
const RESUMING_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

// ── Member access (Phase 3) ───────────────────────────────────────────────────

/**
 * Every foreman of the company with the Cognito state they should have
 * (migration 134; jale_billing alone may execute it). Read in the enforce or
 * restore transaction, so it sees what that transaction just wrote.
 *
 * Under a savepoint: a failed read (a missing grant, a statement error) must
 * not undo the billing enforcement around it. It rolls back to the savepoint,
 * logs member_access_read_failed, and answers no changes; the billing change
 * still commits, and the 15-minute member-access sync converges Cognito.
 */
async function readMemberAccess(
  client: import('pg').PoolClient,
  organizationId: string,
): Promise<MemberAccessChange[]> {
  await client.query('SAVEPOINT member_access_read');
  try {
    const res = await client.query<{ cognito_sub: string; enabled: boolean }>(
      'SELECT cognito_sub, enabled FROM jale_cap.org_member_access($1)',
      [organizationId],
    );
    await client.query('RELEASE SAVEPOINT member_access_read');
    return res.rows.map((row) => ({ cognitoSub: row.cognito_sub, enabled: row.enabled }));
  } catch (err) {
    // If this rollback fails too, the transaction is unusable: let it throw.
    await client.query('ROLLBACK TO SAVEPOINT member_access_read');
    const code = (err as { code?: unknown } | null)?.code;
    console.error(JSON.stringify({
      event: 'member_access_read_failed',
      organizationId,
      code: typeof code === 'string' ? code : 'unknown',
    }));
    return [];
  }
}

/**
 * Applies member access after COMMIT. A Cognito failure never fails the event:
 * the billing change is committed, and the 15-minute member-access sync
 * (member-access-sync.ts) converges whatever is left from the database. The
 * same sync heals a stale apply: a team change that commits and reaches
 * Cognito between this COMMIT and this call can be overwritten here, and the
 * database's membership check holds until the next run (see that file).
 */
async function convergeMemberAccess(
  changes: MemberAccessChange[],
  ctx: { organizationId: string; eventId: string; deadlineAt?: number },
): Promise<void> {
  if (changes.length === 0) return;
  let failed: number;
  try {
    const result = await applyMemberAccess(changes, { deadlineAt: ctx.deadlineAt });
    failed = result.failed.length;
  } catch {
    // applyMemberAccess never throws by contract; this only keeps a broken
    // contract from turning a committed event into a failure.
    failed = changes.length;
  }
  if (failed > 0) {
    console.warn(JSON.stringify({
      event: 'member_access_deferred',
      organizationId: ctx.organizationId,
      eventId: ctx.eventId,
      failed,
    }));
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

interface ClaimResult {
  /** processed/skipped already — no-op, never process again. */
  terminalDuplicate: boolean;
  /**
   * received/failed but a concurrent delivery holds a live (unexpired)
   * lease — do not process and do not touch the row; let SQS redeliver.
   */
  inProgressDuplicate: boolean;
}

async function claimInboxRow(
  eventId: string,
  eventType: string,
  objectId: string | undefined,
): Promise<ClaimResult> {
  const pool = await getDbPool();
  const client = await pool.connect();
  const leaseInterval = `${INBOX_LEASE_MS} milliseconds`;
  try {
    await client.query('BEGIN');

    // Try to INSERT — RETURNING reveals whether this was a fresh insert (row returned)
    // or a conflict (no row returned).
    const insertRes = await client.query(
      `INSERT INTO billing_webhook_events
          (stripe_event_id, event_type, stripe_object_id, processing_status, attempt_count, lease_expires_at)
        VALUES ($1, $2, $3, 'received', 1, now() + ($4::text)::interval)
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING stripe_event_id`,
      [eventId, eventType, objectId ?? null, leaseInterval],
    );

    if (insertRes.rows.length > 0) {
      // Fresh claim — attempt_count=1 and lease already set by INSERT.
      await client.query('COMMIT');
      return { terminalDuplicate: false, inProgressDuplicate: false };
    }

    // Row pre-existed. Claim it atomically in a single UPDATE: only rows
    // that are resumable (received/failed) AND not currently under a live
    // lease qualify. This prevents two concurrent SQS deliveries of the
    // same stripe_event_id from both claiming ownership — whichever UPDATE
    // commits first wins; the loser's WHERE clause no longer matches once
    // it re-evaluates against the committed lease.
    const claimRes = await client.query(
      `UPDATE billing_webhook_events
          SET attempt_count = attempt_count + 1,
              processing_status = 'received',
              lease_expires_at = now() + ($2::text)::interval
        WHERE stripe_event_id = $1
          AND processing_status IN ('received', 'failed')
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING stripe_event_id`,
      [eventId, leaseInterval],
    );

    if (claimRes.rows.length > 0) {
      await client.query('COMMIT');
      return { terminalDuplicate: false, inProgressDuplicate: false };
    }

    // Zero rows claimed — either a terminal state (processed/skipped) or a
    // live lease held by a concurrent in-flight attempt. Distinguish the two
    // without taking any lock beyond a plain read (the UPDATE above already
    // proved we cannot mutate this row right now).
    const res = await client.query(
      `SELECT processing_status
         FROM billing_webhook_events
        WHERE stripe_event_id = $1`,
      [eventId],
    );
    const row = res.rows[0];
    await client.query('COMMIT');

    if (!row) {
      // Should not happen — INSERT was a no-op so the row must exist.
      return { terminalDuplicate: false, inProgressDuplicate: false };
    }

    if (row.processing_status === 'processed' || row.processing_status === 'skipped') {
      return { terminalDuplicate: true, inProgressDuplicate: false };
    }

    // received/failed but excluded by the lease guard → a concurrent
    // in-flight attempt owns it right now.
    return { terminalDuplicate: false, inProgressDuplicate: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markInboxStatus(
  eventId: string,
  status: 'processed' | 'failed' | 'skipped',
  errorCode: string | null,
  processedAt: Date | null,
): Promise<void> {
  const pool = await getDbPool();
  await pool.query(
    `UPDATE billing_webhook_events
        SET processing_status = $2,
            last_error_code   = $3,
            processed_at      = $4,
            lease_expires_at  = NULL
      WHERE stripe_event_id = $1`,
    [eventId, status, errorCode, processedAt],
  );
}

async function markInboxStatusWithClient(
  client: import('pg').PoolClient,
  eventId: string,
  status: 'processed' | 'failed' | 'skipped',
  errorCode: string | null,
  processedAt: Date | null,
): Promise<void> {
  await client.query(
    `UPDATE billing_webhook_events
        SET processing_status = $2,
            last_error_code   = $3,
            processed_at      = $4,
            lease_expires_at  = NULL
      WHERE stripe_event_id = $1`,
    [eventId, status, errorCode, processedAt],
  );
}

/** Persist a failure without going through the full claim path (for malformed bodies). */
async function persistInboxFailure(
  eventId: string,
  eventType: string,
  objectId: string | undefined,
  errorCode: string,
  _terminal: boolean,
): Promise<void> {
  try {
    const pool = await getDbPool();
    await pool.query(
      `INSERT INTO billing_webhook_events
          (stripe_event_id, event_type, stripe_object_id, processing_status, attempt_count, last_error_code)
        VALUES ($1, $2, $3, 'failed', 1, $4)
        ON CONFLICT (stripe_event_id)
          DO UPDATE SET
            processing_status = 'failed',
            attempt_count     = billing_webhook_events.attempt_count + 1,
            last_error_code   = EXCLUDED.last_error_code,
            lease_expires_at  = NULL
          WHERE billing_webhook_events.processing_status NOT IN ('processed', 'skipped')`,
      [eventId, eventType, objectId ?? null, errorCode],
    );
  } catch {
    // Best-effort — don't mask the original error
  }
}

// ── SQS Lambda handler ────────────────────────────────────────────────────────

export const handler: SQSHandler = async (sqsEvent, context) => {
  for (const record of sqsEvent.Records) {
    // Member access stops calling Cognito 5 s before the Lambda times out;
    // the sync picks up what is left.
    const deadlineAt = typeof context?.getRemainingTimeInMillis === 'function'
      ? Date.now() + context.getRemainingTimeInMillis() - 5000
      : undefined;
    await processSqsRecord(record, { deadlineAt });
  }
};

async function processSqsRecord(record: SQSRecord, options: ProcessOptions): Promise<void> {
  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(record.body) as WebhookEnvelope;
  } catch {
    // Malformed SQS message body — can't even parse envelope
    console.error('[billing-processor] malformed SQS record body, cannot process');
    // Throw so SQS retry / DLQ handles it
    throw new Error('malformed_sqs_record');
  }

  const result = await processEnvelope(envelope, options);
  if (result.outcome === 'failed') {
    // Re-throw to let SQS retry/DLQ handle it
    throw new Error(result.errorCode ?? 'processor_failed');
  }
  if (result.outcome === 'duplicate_in_progress') {
    // A concurrent delivery holds a live lease. Throw (rather than deleting
    // this SQS message) so it's redelivered later, after the in-flight
    // attempt has had a chance to finish — protects against silently
    // dropping an event if the in-flight attempt dies without completing.
    throw new Error('duplicate_in_progress');
  }
}
