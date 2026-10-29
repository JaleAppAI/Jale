import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuditCaller } from './audit/caller';
import { setAuditContext } from './audit/context';
import { setRlsContext } from './db';
import { resolveEmployerActor } from './employer-actor';
import { checkCompliance } from '../legal/check-compliance';

export const CHECKOUT_OPERATION_TYPE = 'subscription_checkout';
export const LEASE_MS = 5 * 60 * 1000;

export interface CheckoutRequest {
  planCode: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutOperationReady {
  kind: 'ready';
  operationId: string;
  userId: string;
  /** The payer's company (the owner's organization). */
  organizationId: string;
  email: string | null;
  planCode: string;
  requestHash: string;
  customerIdempotencyKey: string;
  checkoutIdempotencyKey: string;
  /** Existing persisted Stripe customer id for this user, if one is already on file. */
  existingProviderCustomerId: string | null;
}

/**
 * Thrown by persistBillingCustomer when a concurrent checkout already persisted a
 * different provider customer id for this user. Carries the persisted winner so the
 * caller can recover deterministically instead of retrying forever.
 */
export class BillingCustomerConflictError extends Error {
  constructor(public readonly persistedCustomerId: string) {
    super('billing_customer_conflict');
    this.name = 'BillingCustomerConflictError';
  }
}

export interface CheckoutOperationReplay {
  kind: 'replay';
  response: unknown;
}

export interface CheckoutOperationError {
  kind: 'error';
  statusCode: number;
  error: string;
  extra?: Record<string, unknown>;
}

export type CheckoutOperationResult = CheckoutOperationReady | CheckoutOperationReplay | CheckoutOperationError;

export function canonicalCheckoutRequest(request: CheckoutRequest): string {
  return JSON.stringify({
    cancelUrl: request.cancelUrl,
    planCode: request.planCode,
    successUrl: request.successUrl,
  });
}

export function checkoutRequestHash(request: CheckoutRequest): string {
  return createHash('sha256').update(canonicalCheckoutRequest(request)).digest('hex');
}

// Re-exported, not redefined: every caller of this module keeps its import,
// and the check itself lives in `./uuid` where a handler that needs nothing
// else from billing can reach it. See that file.
export { isUuid } from './uuid';

export function assertAllowedReturnUrl(rawUrl: string, allowedOrigin: string): void {
  const url = new URL(rawUrl);
  const allowed = new URL(allowedOrigin);
  if (url.origin !== allowed.origin) throw new Error('invalid_return_origin');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_return_url');
}

export async function prepareCheckoutOperation(
  client: PoolClient,
  cognitoSub: string,
  idempotencyKey: string,
  request: CheckoutRequest,
  requiredTosVersion: string,
): Promise<CheckoutOperationResult> {
  const requestHash = checkoutRequestHash(request);
  await client.query('BEGIN');
  await setRlsContext(client, cognitoSub);

  const compliance = await checkCompliance(client, cognitoSub, requiredTosVersion);
  if (!compliance.userExists) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 409, error: 'user_not_provisioned' };
  }
  if (!compliance.compliant) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 403, error: 'legal_required', extra: { requiredVersion: requiredTosVersion, currentVersion: compliance.currentVersion } };
  }

  const userRes = await client.query(
    `SELECT id, email FROM users WHERE cognito_sub = $1 AND user_type = 'employer' FOR UPDATE`,
    [cognitoSub],
  );
  if (userRes.rows.length !== 1) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 403, error: 'employer_required' };
  }
  const userId = String(userRes.rows[0].id);

  // A company pays one subscription, and only its owner pays (Phase 2). The
  // users row above stays locked for this transaction, as before.
  const actorResult = await resolveEmployerActor(client, cognitoSub);
  if (!actorResult.ok) {
    await client.query('COMMIT');
    // The row above proves an employer exists, so a 409 here cannot happen;
    // answered like the missing-employer case for safety.
    if (actorResult.status === 409) return { kind: 'error', statusCode: 403, error: 'employer_required' };
    if (actorResult.error === 'membership_inactive' && actorResult.membershipStatus) {
      return { kind: 'error', statusCode: actorResult.status, error: actorResult.error, extra: { membershipStatus: actorResult.membershipStatus } };
    }
    return { kind: 'error', statusCode: actorResult.status, error: actorResult.error };
  }
  if (actorResult.actor.role !== 'owner') {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 403, error: 'owner_required' };
  }
  const organizationId = actorResult.actor.organizationId;

  const planRes = await client.query(
    `SELECT code FROM billing_plans WHERE code = $1 AND audience = 'employer' AND active = true`,
    [request.planCode],
  );
  if (planRes.rows.length !== 1) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 400, error: 'invalid_plan' };
  }

  const existingRes = await client.query(
    `SELECT id, request_hash, status, cached_response, lease_expires_at
       FROM billing_operations
      WHERE actor_user_id = $1
        AND operation_type = $2
        AND client_idempotency_key = $3
      FOR UPDATE`,
    [userId, CHECKOUT_OPERATION_TYPE, idempotencyKey],
  );
  const existing = existingRes.rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash) {
      await client.query('COMMIT');
      return { kind: 'error', statusCode: 409, error: 'idempotency_key_conflict' };
    }
    if (existing.status === 'succeeded' && existing.cached_response) {
      await client.query('COMMIT');
      return { kind: 'replay', response: existing.cached_response };
    }
    if (existing.lease_expires_at && new Date(existing.lease_expires_at).getTime() > Date.now()) {
      await client.query('COMMIT');
      return { kind: 'error', statusCode: 409, error: 'operation_in_progress' };
    }

    const operationId = String(existing.id);
    await client.query(
      `UPDATE billing_operations
          SET lease_expires_at = now() + ($2::text)::interval,
              attempt_count = attempt_count + 1,
              updated_at = now()
        WHERE id = $1`,
      [operationId, `${LEASE_MS} milliseconds`],
    );
    const existingCustomerRes = await client.query(
      `SELECT provider_customer_id FROM billing_customers WHERE user_id = $1`,
      [userId],
    );
    await client.query('COMMIT');
    return {
      kind: 'ready',
      operationId,
      userId,
      organizationId,
      email: userRes.rows[0].email ?? null,
      planCode: request.planCode,
      requestHash,
      customerIdempotencyKey: `customer:${userId}`,
      checkoutIdempotencyKey: `checkout:${operationId}`,
      existingProviderCustomerId: existingCustomerRes.rows[0]?.provider_customer_id ?? null,
    };
  }

  const currentSub = await client.query(
    `SELECT 1 FROM subscriptions
      WHERE organization_id = $1
        AND plan_code = $2
        AND (status IN ('active', 'trialing') OR (status = 'past_due' AND grace_ends_at > now()))
      LIMIT 1`,
    [organizationId, request.planCode],
  );
  if (currentSub.rows.length > 0) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 409, error: 'subscription_already_current' };
  }

  const livePending = await client.query(
    `SELECT 1 FROM billing_operations
      WHERE actor_user_id = $1
        AND operation_type = $2
        AND status = 'pending'
        AND lease_expires_at > now()
      LIMIT 1`,
    [userId, CHECKOUT_OPERATION_TYPE],
  );
  if (livePending.rows.length > 0) {
    await client.query('COMMIT');
    return { kind: 'error', statusCode: 409, error: 'operation_in_progress' };
  }

  // m5: gate the cross-key open-checkout replay on request_hash too. Without
  // this, a different idempotency key (new client_idempotency_key) whose body
  // happens to differ from the still-open session would replay a stale
  // Checkout Session created for a different request. Requiring a
  // byte-identical request_hash keeps replay scoped to the same logical
  // request; a changed body instead falls through to creating a new
  // operation/session below.
  const openCheckout = await client.query(
    `SELECT cached_response FROM billing_operations
      WHERE actor_user_id = $1
        AND operation_type = $2
        AND status = 'succeeded'
        AND provider_expires_at > now()
        AND cached_response IS NOT NULL
        AND request_hash = $3
      ORDER BY updated_at DESC
      LIMIT 1`,
    [userId, CHECKOUT_OPERATION_TYPE, requestHash],
  );
  if (openCheckout.rows[0]?.cached_response) {
    await client.query('COMMIT');
    return { kind: 'replay', response: openCheckout.rows[0].cached_response };
  }

  const operationId = randomUUID();
  await client.query(
    `INSERT INTO billing_operations (
       id, actor_user_id, operation_type, client_idempotency_key, request_hash,
       provider_idempotency_key, status, lease_expires_at, attempt_count
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + ($7::text)::interval, 1)`,
    [operationId, userId, CHECKOUT_OPERATION_TYPE, idempotencyKey, requestHash, `checkout:${operationId}`, `${LEASE_MS} milliseconds`],
  );
  const existingCustomerRes = await client.query(
    `SELECT provider_customer_id FROM billing_customers WHERE user_id = $1`,
    [userId],
  );
  await client.query('COMMIT');
  return {
    kind: 'ready',
    operationId,
    userId,
    organizationId,
    email: userRes.rows[0].email ?? null,
    planCode: request.planCode,
    requestHash,
    customerIdempotencyKey: `customer:${userId}`,
    checkoutIdempotencyKey: `checkout:${operationId}`,
    existingProviderCustomerId: existingCustomerRes.rows[0]?.provider_customer_id ?? null,
  };
}

/**
 * The unique keys a concurrent save of this payer's customer can trip: the
 * user_id primary key; 034's provider_customer_id key, which a same-owner race
 * trips first, since both requests get the same Stripe customer from the
 * `customer:${userId}` idempotency key; and 127's one-customer-per-company
 * index. ON CONFLICT (user_id) arbitrates only the first.
 */
const BILLING_CUSTOMER_RACE_CONSTRAINTS = new Set([
  'billing_customers_pkey',
  'billing_customers_provider_customer_id_key',
  'billing_customers_one_per_organization',
]);

function isBillingCustomerRace(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && BILLING_CUSTOMER_RACE_CONSTRAINTS.has(e.constraint ?? '');
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch (_) { /* the original error is what matters */ }
}

/** The payer's stored customer id, read in its own short transaction under the payer's RLS context. */
async function readStoredBillingCustomerId(client: PoolClient, cognitoSub: string, userId: string): Promise<string | undefined> {
  try {
    // BEGIN inside the try: it can fail too (25P02 when the ROLLBACK before it
    // failed), and must not leave the connection aborted.
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);
    const res = await client.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM billing_customers WHERE user_id = $1`,
      [userId],
    );
    await client.query('COMMIT');
    return res.rows[0]?.provider_customer_id;
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  }
}

export async function persistBillingCustomer(
  client: PoolClient,
  cognitoSub: string,
  userId: string,
  organizationId: string,
  providerCustomerId: string,
  caller: AuditCaller,
): Promise<void> {
  await client.query('BEGIN');
  let storedId: string | undefined;
  try {
    await setRlsContext(client, cognitoSub);
    await setAuditContext(client, caller, 'employer.billing_checkout');
    // 127's trigger checks organization_id is the payer's company and that the
    // payer is its active owner.
    await client.query(
      `INSERT INTO billing_customers (user_id, provider, provider_customer_id, organization_id)
       VALUES ($1, 'stripe', $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, providerCustomerId, organizationId],
    );
    const res = await client.query(
      `SELECT provider_customer_id FROM billing_customers WHERE user_id = $1`,
      [userId],
    );
    storedId = res.rows[0]?.provider_customer_id;
    if (storedId === providerCustomerId) {
      await client.query('COMMIT');
      return;
    }
  } catch (err) {
    // Any failure (127's trigger refusal 42501 included) leaves the
    // transaction aborted: roll back before the caller reuses the connection.
    await rollbackQuietly(client);
    if (!isBillingCustomerRace(err)) throw err;
    // A concurrent checkout by the same owner saved its customer first, through
    // a key the ON CONFLICT arbiter does not cover. Re-read the stored id: the
    // same customer means the other request saved ours; otherwise it is the
    // "another customer is already saved" outcome below.
    const winner = await readStoredBillingCustomerId(client, cognitoSub, userId);
    // No row for this payer: another payer holds the company's customer, not a race with ourselves.
    if (winner === undefined) throw err;
    if (winner === providerCustomerId) return;
    throw new BillingCustomerConflictError(winner);
  }
  // Another customer is already saved for this payer.
  await client.query('ROLLBACK');
  throw new BillingCustomerConflictError(storedId as string);
}

export async function markCheckoutSucceeded(
  client: PoolClient,
  cognitoSub: string,
  operationId: string,
  providerObjectId: string,
  providerExpiresAt: Date,
  response: { url: string; sessionId: string },
): Promise<void> {
  await client.query('BEGIN');
  await setRlsContext(client, cognitoSub);
  await client.query(
    `UPDATE billing_operations
        SET status = 'succeeded',
            provider_object_id = $2,
            provider_expires_at = $3,
            cached_response = $4::jsonb,
            lease_expires_at = NULL,
            last_error_code = NULL,
            updated_at = now()
      WHERE id = $1`,
    [operationId, providerObjectId, providerExpiresAt, JSON.stringify(response)],
  );
  await client.query('COMMIT');
}

export async function recordCheckoutFailure(
  client: PoolClient,
  cognitoSub: string,
  operationId: string,
  code: string,
  terminal: boolean,
): Promise<void> {
  await client.query('BEGIN');
  await setRlsContext(client, cognitoSub);
  await client.query(
    `UPDATE billing_operations
        SET status = CASE WHEN $3 THEN 'failed' ELSE status END,
            last_error_code = $2,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [operationId, code, terminal],
  );
  await client.query('COMMIT');
}
