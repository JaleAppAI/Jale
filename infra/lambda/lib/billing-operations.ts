import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { setRlsContext } from './db';
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
  email: string | null;
  planCode: string;
  requestHash: string;
  customerIdempotencyKey: string;
  checkoutIdempotencyKey: string;
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

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

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
    await client.query('COMMIT');
    return {
      kind: 'ready',
      operationId,
      userId,
      email: userRes.rows[0].email ?? null,
      planCode: request.planCode,
      requestHash,
      customerIdempotencyKey: `customer:${userId}`,
      checkoutIdempotencyKey: `checkout:${operationId}`,
    };
  }

  const currentSub = await client.query(
    `SELECT 1 FROM subscriptions
      WHERE user_id = $1
        AND plan_code = $2
        AND (status IN ('active', 'trialing') OR (status = 'past_due' AND grace_ends_at > now()))
      LIMIT 1`,
    [userId, request.planCode],
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

  const openCheckout = await client.query(
    `SELECT cached_response FROM billing_operations
      WHERE actor_user_id = $1
        AND operation_type = $2
        AND status = 'succeeded'
        AND provider_expires_at > now()
        AND cached_response IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [userId, CHECKOUT_OPERATION_TYPE],
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
  await client.query('COMMIT');
  return {
    kind: 'ready',
    operationId,
    userId,
    email: userRes.rows[0].email ?? null,
    planCode: request.planCode,
    requestHash,
    customerIdempotencyKey: `customer:${userId}`,
    checkoutIdempotencyKey: `checkout:${operationId}`,
  };
}

export async function persistBillingCustomer(
  client: PoolClient,
  cognitoSub: string,
  userId: string,
  providerCustomerId: string,
): Promise<void> {
  await client.query('BEGIN');
  await setRlsContext(client, cognitoSub);
  await client.query(
    `INSERT INTO billing_customers (user_id, provider, provider_customer_id)
     VALUES ($1, 'stripe', $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, providerCustomerId],
  );
  const res = await client.query(
    `SELECT provider_customer_id FROM billing_customers WHERE user_id = $1`,
    [userId],
  );
  if (res.rows[0]?.provider_customer_id !== providerCustomerId) {
    await client.query('ROLLBACK');
    throw new Error('billing_customer_conflict');
  }
  await client.query('COMMIT');
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
