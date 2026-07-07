/**
 * Billing webhook processor Lambda.
 *
 * SQS consumer (batch size 1). Runs as jale_billing service role.
 * Processes Stripe v1 snapshot events from the billing webhook queue.
 *
 * Processing lifecycle:
 *  1. Claim inbox row by stripe_event_id (INSERT ON CONFLICT).
 *     - processed/skipped → terminal duplicate no-op.
 *     - failed/received → resumable: increment attempt_count.
 *  2. Persist claim/attempt state in a short transaction.
 *  3. Fetch authoritative Stripe state OUTSIDE any DB transaction.
 *  4. Mirror subscription state + mark processed in a final transaction.
 *
 * Runs as jale_billing which has:
 *   SELECT billing_plans, billing_customers
 *   SELECT/INSERT/UPDATE subscriptions, billing_webhook_events
 *   NO users-table access — correlate via billing_customers.provider_customer_id
 */
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import Stripe = require('stripe');
import { getDbPool } from '../lib/db';
import { getStripe, getStripeSecret } from '../lib/stripe-client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface WebhookEnvelope {
  eventId: string;
  eventType: string;
  receivedAt: string;
  rawBody: string; // base64-encoded raw bytes of the Stripe event
}

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
  outcome: 'processed' | 'skipped' | 'failed' | 'duplicate_terminal';
  errorCode?: string;
}

export async function processEnvelope(envelope: WebhookEnvelope): Promise<ProcessResult> {
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

  // ── Step 2: Dispatch by event type ────────────────────────────────────
  const knownSubscriptionEvents = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
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

  try {
    const result = await handleSubscriptionEvent(stripeEvent, eventId, eventType);
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

  // Look up user_id via billing_customers
  const pool = await getDbPool();
  const customerRes = await pool.query(
    'SELECT user_id FROM billing_customers WHERE provider_customer_id = $1',
    [customerId],
  );
  if (customerRes.rows.length === 0) {
    await markInboxStatus(eventId, 'failed', 'unknown_customer', null);
    return { outcome: 'failed', errorCode: 'unknown_customer' };
  }
  const userId: string = String(customerRes.rows[0].user_id);

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    await client.query(
      `INSERT INTO subscriptions (
          user_id, plan_code, provider_subscription_id, status,
          current_period_start, current_period_end, cancel_at_period_end,
          grace_ends_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $4 = 'past_due' AND $8::timestamptz IS NULL
               THEN now() + interval '7 days'
               ELSE $8::timestamptz
          END,
          now())
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
           updated_at           = now()`,
      [
        userId,
        planCode,
        providerSubId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        graceFragment,
      ],
    );

    await markInboxStatusWithClient(client, eventId, 'processed', null, new Date());
    await client.query('COMMIT');
    return { outcome: 'processed' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

interface ClaimResult {
  terminalDuplicate: boolean;
}

async function claimInboxRow(
  eventId: string,
  eventType: string,
  objectId: string | undefined,
): Promise<ClaimResult> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Try to INSERT — RETURNING reveals whether this was a fresh insert (row returned)
    // or a conflict (no row returned).
    const insertRes = await client.query(
      `INSERT INTO billing_webhook_events
          (stripe_event_id, event_type, stripe_object_id, processing_status, attempt_count)
        VALUES ($1, $2, $3, 'received', 1)
        ON CONFLICT (stripe_event_id) DO NOTHING
        RETURNING stripe_event_id`,
      [eventId, eventType, objectId ?? null],
    );

    if (insertRes.rows.length > 0) {
      // Fresh claim — attempt_count=1 already set by INSERT; no further UPDATE needed.
      await client.query('COMMIT');
      return { terminalDuplicate: false };
    }

    // Row pre-existed — check status and branch.
    const res = await client.query(
      `SELECT processing_status, attempt_count
         FROM billing_webhook_events
        WHERE stripe_event_id = $1
        FOR UPDATE`,
      [eventId],
    );
    const row = res.rows[0];

    if (!row) {
      // Should not happen — INSERT was a no-op so the row must exist
      await client.query('COMMIT');
      return { terminalDuplicate: false };
    }

    const { processing_status, attempt_count } = row;

    // Terminal states: processed/skipped → no-op
    if (processing_status === 'processed' || processing_status === 'skipped') {
      await client.query('COMMIT');
      return { terminalDuplicate: true };
    }

    // received/failed → resumable: increment attempt_count by exactly 1
    await client.query(
      `UPDATE billing_webhook_events
          SET attempt_count = $2,
              processing_status = 'received'
        WHERE stripe_event_id = $1`,
      [eventId, (attempt_count as number) + 1],
    );

    await client.query('COMMIT');
    return { terminalDuplicate: false };
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
            processed_at      = $4
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
            processed_at      = $4
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
            last_error_code   = EXCLUDED.last_error_code`,
      [eventId, eventType, objectId ?? null, errorCode],
    );
  } catch {
    // Best-effort — don't mask the original error
  }
}

// ── SQS Lambda handler ────────────────────────────────────────────────────────

export const handler: SQSHandler = async (sqsEvent) => {
  for (const record of sqsEvent.Records) {
    await processSqsRecord(record);
  }
};

async function processSqsRecord(record: SQSRecord): Promise<void> {
  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(record.body) as WebhookEnvelope;
  } catch {
    // Malformed SQS message body — can't even parse envelope
    console.error('[billing-processor] malformed SQS record body, cannot process');
    // Throw so SQS retry / DLQ handles it
    throw new Error('malformed_sqs_record');
  }

  const result = await processEnvelope(envelope);
  if (result.outcome === 'failed') {
    // Re-throw to let SQS retry/DLQ handle it
    throw new Error(result.errorCode ?? 'processor_failed');
  }
}
