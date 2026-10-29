import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../../../lambda/lib/db';
import { setAuditContext } from '../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './api/audit-expectations';
import { checkCompliance } from '../../../lambda/legal/check-compliance';
import { getStripe, getStripeSecret, StripeConfigError } from '../../../lambda/lib/stripe-client';
import { BillingCustomerConflictError, checkoutRequestHash, persistBillingCustomer } from '../../../lambda/lib/billing-operations';
import { handler } from '../../../lambda/billing/checkout';
import { resolveEmployerActor } from '../../../lambda/lib/employer-actor';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/lib/audit/context');
jest.mock('../../../lambda/legal/check-compliance');
// Keep the real StripeConfigError class (so `instanceof` checks in
// checkout.ts work against genuine instances) while mocking the async
// functions.
jest.mock('../../../lambda/lib/stripe-client', () => ({
  ...jest.requireActual('../../../lambda/lib/stripe-client'),
  getStripe: jest.fn(),
  getStripeSecret: jest.fn(),
}));
jest.mock('../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetStripe = getStripe as jest.Mock;
const mockGetStripeSecret = getStripeSecret as jest.Mock;
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const OWNER_ACTOR = { ok: true, actor: { userId: 'user-1', organizationId: 'org-1', role: 'owner', scopeUserIds: ['user-1'] } };
const FOREMAN_ACTOR = { ok: true, actor: { userId: 'user-1', organizationId: 'org-1', role: 'foreman', scopeUserIds: ['user-1'] } };

const checkoutCreate = jest.fn();
const customerCreate = jest.fn();
const release = jest.fn();
const query = jest.fn();

const body = {
  planCode: 'employer_pro',
  successUrl: 'http://localhost:3000/billing/success',
  cancelUrl: 'http://localhost:3000/billing/cancel',
};

function event(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    requestContext: { authorizer: { claims: { sub: 'cognito-sub' } } },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function wireDb() {
  mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query, release }) });
}

describe('billing checkout handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, ALLOWED_ORIGIN: 'http://localhost:3000', REQUIRED_TOS_VERSION: 'v1' };
    wireDb();
    mockResolveEmployerActor.mockResolvedValue(OWNER_ACTOR);
    mockCheckCompliance.mockResolvedValue({ userExists: true, compliant: true, currentVersion: 'v1' });
    mockGetStripeSecret.mockResolvedValue({ priceIdEmployerPro: 'price_employer_pro' });
    mockGetStripe.mockResolvedValue({
      customers: { create: customerCreate },
      checkout: { sessions: { create: checkoutCreate } },
    });
    customerCreate.mockResolvedValue({ id: 'cus_123' });
    checkoutCreate.mockResolvedValue({ id: 'cs_123', url: 'https://checkout.stripe.test/session', expires_at: 2_000_000 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects missing or malformed idempotency keys before DB or Stripe work', async () => {
    const res = await handler(event({ headers: {} }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_idempotency_key' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it('returns exact cached response on same-key replay and performs zero Stripe mutations', async () => {
    const cached = { url: 'https://cached.example/session', sessionId: 'cs_cached' };
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('FROM billing_operations') && sql.includes('client_idempotency_key')) {
        return Promise.resolve({ rows: [{ id: 'op-1', request_hash: checkoutRequestHash(body), status: 'succeeded', cached_response: cached }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(cached);
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'cognito-sub');
  });

  it('returns 409 when the same idempotency key is reused with a changed body', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('FROM billing_operations') && sql.includes('client_idempotency_key')) {
        return Promise.resolve({ rows: [{ id: 'op-1', request_hash: 'different-hash', status: 'pending' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'idempotency_key_conflict' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('returns operation_in_progress for a different client key while an actor checkout lease is live', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('client_idempotency_key')) return Promise.resolve({ rows: [] });
      if (sql.includes("status = 'pending'") && sql.includes('lease_expires_at > now()')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'operation_in_progress' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('returns subscription_already_current for an active mirrored subscription before Stripe work', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('client_idempotency_key')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM subscriptions') && sql.includes('status IN')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'subscription_already_current' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('resumes an expired same-key lease with the same operation and provider idempotency keys, reusing the persisted customer', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('FROM billing_operations') && sql.includes('client_idempotency_key')) {
        return Promise.resolve({
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            request_hash: checkoutRequestHash(body),
            status: 'pending',
            cached_response: null,
            lease_expires_at: new Date(Date.now() - 1000).toISOString(),
          }],
        });
      }
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    // Existing persisted customer — checkout must reuse it directly, never call customers.create.
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123' }),
      { idempotencyKey: 'checkout:22222222-2222-4222-8222-222222222222' },
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('attempt_count = attempt_count + 1'),
      ['22222222-2222-4222-8222-222222222222', expect.any(String)],
    );
  });

  it('permits a new operation when the only prior Checkout Session is expired', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('client_idempotency_key')) return Promise.resolve({ rows: [] });
      if (sql.includes('provider_expires_at > now()')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO billing_operations'), expect.arrayContaining(['user-1']));
    expect(checkoutCreate).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) }));
  });

  it('m5: replays the open checkout for a new idempotency key when the request_hash matches (same body)', async () => {
    const cachedOpen = { url: 'https://cached.example/open-session', sessionId: 'cs_open' };
    query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('client_idempotency_key')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM subscriptions')) return Promise.resolve({ rows: [] });
      if (sql.includes("status = 'pending'") && sql.includes('lease_expires_at > now()')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM billing_operations') && sql.includes('provider_expires_at > now()')) {
        expect(sql).toContain('request_hash = $3');
        const requestHash = params[params.length - 1];
        if (requestHash === checkoutRequestHash(body)) return Promise.resolve({ rows: [{ cached_response: cachedOpen }] });
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event({ headers: { 'Idempotency-Key': '44444444-4444-4444-8444-444444444444' } }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(cachedOpen);
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it('m5: does NOT replay the open checkout for a new idempotency key with a changed body (different request_hash) — creates a new operation', async () => {
    const cachedOpen = { url: 'https://cached.example/open-session', sessionId: 'cs_open' };
    const differentBody = { ...body, planCode: 'employer_pro_v2' };
    query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro_v2' }] });
      if (sql.includes('client_idempotency_key')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM subscriptions')) return Promise.resolve({ rows: [] });
      if (sql.includes("status = 'pending'") && sql.includes('lease_expires_at > now()')) return Promise.resolve({ rows: [] });
      if (sql.includes('FROM billing_operations') && sql.includes('provider_expires_at > now()')) {
        // The stale open session's hash belongs to the OLD body — the new,
        // different-body request_hash must not match it.
        const requestHash = params[params.length - 1];
        if (requestHash === checkoutRequestHash(body)) return Promise.resolve({ rows: [{ cached_response: cachedOpen }] });
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event({
      body: JSON.stringify(differentBody),
      headers: { 'Idempotency-Key': '55555555-5555-4555-8555-555555555555' },
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    expect(checkoutCreate).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO billing_operations'), expect.arrayContaining(['user-1']));
  });

  it('returns billing_configuration_invalid and marks operation failed when the Stripe price is missing', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetStripeSecret.mockResolvedValue({});
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('lease_expires_at = NULL'),
      expect.arrayContaining(['stripe_price_missing', true]),
    );
    expect(errorLog).toHaveBeenCalledWith('billing-checkout configuration error:', 'stripe_price_missing');
    errorLog.mockRestore();
  });

  it('returns billing_configuration_invalid (not 503) and marks the operation terminally failed when getStripeSecret throws StripeConfigError', async () => {
    mockGetStripeSecret.mockRejectedValue(new StripeConfigError('stripe_api_secret_invalid_key'));
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
    // Terminal failure — status flips to 'failed', unlike the retryable path.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['stripe_api_secret_invalid_key', true]),
    );
  });

  it('returns 503 and keeps the operation resumable when Secrets Manager throttles', async () => {
    mockGetStripeSecret.mockRejectedValue({
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'provider_retryable' });
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('lease_expires_at = NULL'),
      expect.arrayContaining(['stripe_retryable_error', false]),
    );
  });

  it('returns billing_configuration_invalid when getStripe (not just getStripeSecret) throws StripeConfigError', async () => {
    mockGetStripeSecret.mockResolvedValue({ priceIdEmployerPro: 'price_employer_pro' });
    mockGetStripe.mockRejectedValue(new StripeConfigError('stripe_secret_arn_missing'));
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['stripe_secret_arn_missing', true]),
    );
  });

  it('resumes and succeeds on a same-key retry after a prior config-error attempt once the secret loads', async () => {
    // First attempt: secret is broken.
    mockGetStripeSecret.mockRejectedValueOnce(new StripeConfigError('stripe_api_secret_invalid_key'));
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });
    const firstRes = await handler(event());
    expect(firstRes.statusCode).toBe(500);
    expect(JSON.parse(firstRes.body)).toEqual({ error: 'billing_configuration_invalid' });

    // Second attempt, same idempotency key: secret now loads fine and the
    // operation resumes from the same (now-failed, lease-cleared) row.
    mockGetStripeSecret.mockResolvedValue({ priceIdEmployerPro: 'price_employer_pro' });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('FROM billing_operations') && sql.includes('client_idempotency_key')) {
        return Promise.resolve({
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            request_hash: checkoutRequestHash(body),
            status: 'failed',
            cached_response: null,
            lease_expires_at: null,
          }],
        });
      }
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const secondRes = await handler(event());
    expect(secondRes.statusCode).toBe(200);
    expect(JSON.parse(secondRes.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123' }),
      { idempotencyKey: 'checkout:33333333-3333-4333-8333-333333333333' },
    );
  });

  it('leaves the operation resumable on provider 429/5xx retryable failures', async () => {
    checkoutCreate.mockRejectedValue({ statusCode: 500, code: 'api_connection_error' });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'provider_retryable' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['api_connection_error', false]),
    );
  });

  it('marks the operation failed on terminal provider 4xx failures', async () => {
    checkoutCreate.mockRejectedValue({ statusCode: 400, code: 'parameter_invalid' });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'provider_error' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['parameter_invalid', true]),
    );
  });

  it('leaves the operation resumable when Customer creation times out after the provider may have succeeded', async () => {
    customerCreate.mockRejectedValue({ statusCode: 500, code: 'api_connection_error' });
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'provider_retryable' });
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['api_connection_error', false]),
    );
  });

  it('commits the operation transaction before calling Stripe and stores the cached session response (first-time customer creation)', async () => {
    const calls: string[] = [];
    let billingCustomersCallCount = 0;
    query.mockImplementation((sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
        billingCustomersCallCount += 1;
        // 1st call = prepareCheckoutOperation's lookup — no prior customer, so
        // customer creation is expected. 2nd call = persistBillingCustomer's
        // post-INSERT verification SELECT, confirming the freshly-created id won.
        if (billingCustomersCallCount === 1) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    customerCreate.mockImplementation(async () => {
      expect(calls).toContain('COMMIT');
      return { id: 'cus_123' };
    });
    checkoutCreate.mockImplementation(async () => {
      expect(calls.filter((call) => call === 'COMMIT').length).toBeGreaterThanOrEqual(2);
      return { id: 'cs_123', url: 'https://checkout.stripe.test/session', expires_at: 2_000_000 };
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    expect(customerCreate).toHaveBeenCalledWith(
      { email: 'e@example.com', metadata: { userId: 'user-1', organizationId: 'org-1' } },
      { idempotencyKey: 'customer:user-1' },
    );
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_123',
        success_url: body.successUrl,
        cancel_url: body.cancelUrl,
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) }),
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining("cached_response = $4::jsonb"), expect.arrayContaining(['cs_123']));
    // prepareCheckoutOperation + persistBillingCustomer + markCheckoutSucceeded.
    expect(mockSetRlsContext).toHaveBeenCalledTimes(3);
  });

  it('holds no transaction open across any network call (secret read, customer create, session create)', async () => {
    let open = false;
    const openAtCall: Record<string, boolean> = {};
    let billingCustomersCallCount = 0;
    query.mockImplementation((sql: string) => {
      const statement = sql.trim().toUpperCase();
      if (statement === 'BEGIN') open = true;
      if (statement === 'COMMIT' || statement === 'ROLLBACK') open = false;
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
        billingCustomersCallCount += 1;
        if (billingCustomersCallCount === 1) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockGetStripeSecret.mockImplementation(async () => {
      openAtCall.getStripeSecret = open;
      return { priceIdEmployerPro: 'price_employer_pro' };
    });
    customerCreate.mockImplementation(async () => {
      openAtCall.customersCreate = open;
      return { id: 'cus_123' };
    });
    checkoutCreate.mockImplementation(async () => {
      openAtCall.sessionsCreate = open;
      return { id: 'cs_123', url: 'https://checkout.stripe.test/session', expires_at: 2_000_000 };
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(openAtCall).toEqual({ getStripeSecret: false, customersCreate: false, sessionsCreate: false });
    expect(open).toBe(false);
  });

  it('reuses an existing persisted customer and performs zero Stripe customers.create calls', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_existing' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing' }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) }),
    );
    // No persistBillingCustomer transaction is opened when reusing — only
    // prepareCheckoutOperation + markCheckoutSucceeded.
    expect(mockSetRlsContext).toHaveBeenCalledTimes(2);
  });

  it('when persistBillingCustomer detects a divergent conflict, checkout resolves to the persisted winner (not a retry loop)', async () => {
    // Exercise the BillingCustomerConflictError recovery path directly: no
    // existing customer at prepare time (forces stripe.customers.create), but
    // persistBillingCustomer's own verification SELECT reports a different,
    // already-persisted winner (a concurrent checkout raced us).
    let billingCustomersCallCount = 0;
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
        billingCustomersCallCount += 1;
        // 1st call = prepareCheckoutOperation's lookup (no row yet).
        if (billingCustomersCallCount === 1) return Promise.resolve({ rows: [] });
        // 2nd call = persistBillingCustomer's post-INSERT verification SELECT —
        // ON CONFLICT DO NOTHING left the concurrent winner's row in place.
        return Promise.resolve({ rows: [{ provider_customer_id: 'cus_concurrent_winner' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    customerCreate.mockResolvedValue({ id: 'cus_B_orphaned' });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session', sessionId: 'cs_123' });
    // A Stripe customer was created (cus_B_orphaned, now orphaned) but checkout
    // must NOT fail/retry — it resolves deterministically to the persisted winner.
    expect(customerCreate).toHaveBeenCalled();
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_concurrent_winner' }),
      expect.any(Object),
    );
    // Never treated as a retryable provider error — no ROLLBACK-driven 503.
    expect(res.statusCode).not.toBe(503);
  });

  it('when a concurrent checkout trips the one-customer-per-company index (23505), checkout resolves to the persisted winner', async () => {
    let inTx = false;
    let aborted = false;
    let billingCustomersReads = 0;
    query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') { inTx = true; return Promise.resolve({ rows: [] }); }
      if (sql === 'ROLLBACK') { inTx = false; aborted = false; return Promise.resolve({ rows: [] }); }
      if (aborted) return Promise.reject(Object.assign(new Error('current transaction is aborted'), { code: '25P02' }));
      if (sql === 'COMMIT') { inTx = false; return Promise.resolve({ rows: [] }); }
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('INSERT INTO billing_customers')) {
        aborted = inTx;
        return Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'billing_customers_one_per_organization' }));
      }
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
        billingCustomersReads += 1;
        // 1st = prepare-time lookup (none yet); 2nd = the post-ROLLBACK re-read.
        return Promise.resolve({ rows: billingCustomersReads === 1 ? [] : [{ provider_customer_id: 'cus_concurrent_winner' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    customerCreate.mockResolvedValue({ id: 'cus_B_orphaned' });

    const res = await handler(event());

    expect(res.statusCode).toBe(200);
    expect(checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_concurrent_winner' }), expect.any(Object));
  });

  describe('persistBillingCustomer', () => {
    const caller = { kind: 'employer', id: 'user-1' } as unknown as Parameters<typeof persistBillingCustomer>[5];
    const sqls = () => query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(' '));
    const persist = (customerId = 'cus_mine') =>
      persistBillingCustomer({ query } as never, 'cognito-sub', 'user-1', 'org-1', customerId, caller);
    const uniqueViolation = (constraint: string) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    const insertRejects = (err: unknown, storedRows: Array<{ provider_customer_id: string }>) =>
      query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_customers')) return Promise.reject(err);
        if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: storedRows });
        return Promise.resolve({ rows: [] });
      });

    it('happy path: inserts, verifies and commits in one transaction, with no ROLLBACK', async () => {
      query.mockImplementation((sql: string) => (sql.includes('SELECT provider_customer_id')
        ? Promise.resolve({ rows: [{ provider_customer_id: 'cus_mine' }] })
        : Promise.resolve({ rows: [] })));

      await expect(persist()).resolves.toBeUndefined();

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'SELECT provider_customer_id', 'COMMIT']);
      expect(mockSetRlsContext).toHaveBeenCalledTimes(1);
    });

    it('a 23505 on billing_customers_one_per_organization rolls back, re-reads in a fresh RLS transaction, and throws the conflict with the stored id', async () => {
      insertRejects(uniqueViolation('billing_customers_one_per_organization'), [{ provider_customer_id: 'cus_winner' }]);

      const err = await persist().catch((e) => e);

      expect(err).toBeInstanceOf(BillingCustomerConflictError);
      expect(err.persistedCustomerId).toBe('cus_winner');
      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK', 'BEGIN', 'SELECT provider_customer_id', 'COMMIT']);
      expect(mockSetRlsContext).toHaveBeenCalledTimes(2);
      expect(mockSetRlsContext).toHaveBeenLastCalledWith(expect.any(Object), 'cognito-sub');
      const reread = query.mock.calls.filter(([sql]) => String(sql).includes('SELECT provider_customer_id')).pop();
      expect(String(reread![0])).toMatch(/WHERE user_id = \$1/);
      expect(reread![1]).toEqual(['user-1']);
    });

    it('a 23505 on the user_id key whose stored id is this same customer returns normally (the other request saved it)', async () => {
      insertRejects(uniqueViolation('billing_customers_pkey'), [{ provider_customer_id: 'cus_mine' }]);

      await expect(persist('cus_mine')).resolves.toBeUndefined();

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK', 'BEGIN', 'SELECT provider_customer_id', 'COMMIT']);
    });

    it('a 23505 on the company index with no row for this user (another payer holds it) rolls back and rethrows the 23505', async () => {
      const dup = uniqueViolation('billing_customers_one_per_organization');
      insertRejects(dup, []);

      await expect(persist()).rejects.toBe(dup);

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK', 'BEGIN', 'SELECT provider_customer_id', 'COMMIT']);
    });

    it('a 23505 on the provider_customer_id key (same Stripe customer via the shared idempotency key) re-reads and returns normally', async () => {
      insertRejects(uniqueViolation('billing_customers_provider_customer_id_key'), [{ provider_customer_id: 'cus_mine' }]);

      await expect(persist('cus_mine')).resolves.toBeUndefined();

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK', 'BEGIN', 'SELECT provider_customer_id', 'COMMIT']);
    });

    it('a re-read whose BEGIN fails (25P02 after a failed ROLLBACK) is rolled back quietly and its error rethrown', async () => {
      const aborted = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      let begins = 0;
      query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_customers')) return Promise.reject(uniqueViolation('billing_customers_one_per_organization'));
        if (sql === 'ROLLBACK') return Promise.reject(new Error('connection hiccup'));
        if (sql === 'BEGIN') return (begins += 1) === 1 ? Promise.resolve({ rows: [] }) : Promise.reject(aborted);
        return Promise.resolve({ rows: [] });
      });

      await expect(persist()).rejects.toBe(aborted);

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
    });

    it('a 23505 on any other constraint rolls back and rethrows without a re-read', async () => {
      const dup = uniqueViolation('billing_customers_some_other_key');
      insertRejects(dup, [{ provider_customer_id: 'cus_winner' }]);

      await expect(persist()).rejects.toBe(dup);

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK']);
    });

    it("a 42501 from 127's trigger rolls back first, then rethrows the same error (no typed refusal yet)", async () => {
      const refused = Object.assign(new Error('not the active owner'), { code: '42501' });
      insertRejects(refused, []);

      await expect(persist()).rejects.toBe(refused);

      expect(sqls()).toEqual(['BEGIN', 'INSERT INTO', 'ROLLBACK']);
    });

    it('a failing ROLLBACK is ignored and the original error is still rethrown', async () => {
      const refused = Object.assign(new Error('not the active owner'), { code: '42501' });
      query.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_customers')) return Promise.reject(refused);
        if (sql === 'ROLLBACK') return Promise.reject(new Error('connection terminated'));
        return Promise.resolve({ rows: [] });
      });

      await expect(persist()).rejects.toBe(refused);
    });
  });

  describe('the company (Phase 2)', () => {
    const users = (sql: string) => (sql.includes('SELECT id, email FROM users') ? Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] }) : undefined);

    it('checkout: 403 owner_required for a foreman, before any Stripe call', async () => {
      mockResolveEmployerActor.mockResolvedValue(FOREMAN_ACTOR);
      query.mockImplementation((sql: string) => users(sql) ?? Promise.resolve({ rows: [] }));

      const res = await handler(event());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
      expect(mockGetStripe).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => String(sql).includes('billing_operations'))).toBe(false);
      expect(query).toHaveBeenCalledWith('COMMIT');
    });

    it('checkout: answers the actor failure for a suspended member', async () => {
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
      query.mockImplementation((sql: string) => users(sql) ?? Promise.resolve({ rows: [] }));

      const res = await handler(event());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
      expect(mockGetStripe).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => String(sql).includes('billing_operations'))).toBe(false);
      expect(query).toHaveBeenCalledWith('COMMIT');
    });

    it.each(['suspended', 'removed'] as const)('checkout: the actor failure for a %s member carries membershipStatus', async (membershipStatus) => {
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive', membershipStatus });
      query.mockImplementation((sql: string) => users(sql) ?? Promise.resolve({ rows: [] }));

      const res = await handler(event());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus });
      expect(mockGetStripe).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith('COMMIT');
    });

    it('checkout: answers 403 no_organization for an employer with no company, before any Stripe call', async () => {
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'no_organization' });
      query.mockImplementation((sql: string) => users(sql) ?? Promise.resolve({ rows: [] }));

      const res = await handler(event());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'no_organization' });
      expect(mockGetStripe).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => String(sql).includes('billing_operations'))).toBe(false);
      expect(query).toHaveBeenCalledWith('COMMIT');
    });

    it('checkout: an actor 409 (unreachable after the users lock) is answered 403 employer_required', async () => {
      mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 409, error: 'user_not_provisioned' });
      query.mockImplementation((sql: string) => users(sql) ?? Promise.resolve({ rows: [] }));

      const res = await handler(event());

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'employer_required' });
      expect(mockGetStripe).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => String(sql).includes('billing_operations'))).toBe(false);
      expect(query).toHaveBeenCalledWith('COMMIT');
    });

    it('checkout: "already subscribed" is the company\'s current subscription', async () => {
      query.mockImplementation((sql: string) => {
        const u = users(sql);
        if (u) return u;
        if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
        if (sql.includes('FROM subscriptions') && sql.includes('status IN')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
        return Promise.resolve({ rows: [] });
      });

      const res = await handler(event());

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'subscription_already_current' });
      const current = query.mock.calls.find(([sql]) => String(sql).includes('FROM subscriptions') && String(sql).includes('status IN'));
      expect(String(current![0])).toMatch(/WHERE organization_id = \$1/);
      expect(current![1]).toEqual(['org-1', 'employer_pro']);
    });

    it('checkout: stores the company on the new Stripe customer row and in the Stripe metadata', async () => {
      let inserted = false;
      query.mockImplementation((sql: string) => {
        const u = users(sql);
        if (u) return u;
        if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
        if (sql.includes('INSERT INTO billing_customers')) {
          inserted = true;
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
          return Promise.resolve({ rows: inserted ? [{ provider_customer_id: 'cus_123' }] : [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await handler(event());

      expect(res.statusCode).toBe(200);
      const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO billing_customers'));
      expect(String(insert![0])).toMatch(/\(user_id, provider, provider_customer_id, organization_id\)/);
      expect(insert![1]).toEqual(['user-1', 'cus_123', 'org-1']);
      expect(customerCreate).toHaveBeenCalledWith(
        { email: 'e@example.com', metadata: { userId: 'user-1', organizationId: 'org-1' } },
        { idempotencyKey: 'customer:user-1' },
      );
      expect(checkoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          client_reference_id: 'user-1',
          metadata: expect.objectContaining({ userId: 'user-1', organizationId: 'org-1', planCode: 'employer_pro' }),
        }),
        expect.anything(),
      );
    });
  });

  describe('change context', () => {
    it('states the employer in the transaction that stores a new payment customer', async () => {
      let inserted = false;
      query.mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: null }] });
        if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
        if (sql.includes('INSERT INTO billing_customers')) {
          inserted = true;
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('SELECT provider_customer_id FROM billing_customers')) {
          return Promise.resolve({ rows: inserted ? [{ provider_customer_id: 'cus_123' }] : [] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await handler(withRequestId(event()));
      expect(res.statusCode).toBe(200);
      expect(customerCreate).toHaveBeenCalled();
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(expect.objectContaining({ query }), callerFor('employer', 'user-1'), 'employer.billing_checkout');
      expectContextBeforeWrite(query, setAuditContext as jest.Mock, /INSERT INTO billing_customers/);
    });
  });
});
