import type { APIGatewayProxyEvent } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../../../lambda/lib/db';
import { checkCompliance } from '../../../lambda/legal/check-compliance';
import { getStripe, getStripeSecret } from '../../../lambda/lib/stripe-client';
import { checkoutRequestHash } from '../../../lambda/lib/billing-operations';
import { handler } from '../../../lambda/billing/checkout';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/legal/check-compliance');
jest.mock('../../../lambda/lib/stripe-client');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetStripe = getStripe as jest.Mock;
const mockGetStripeSecret = getStripeSecret as jest.Mock;

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

  it('resumes an expired same-key lease with the same operation and provider idempotency keys', async () => {
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
    expect(customerCreate).toHaveBeenCalledWith(expect.any(Object), { idempotencyKey: 'customer:user-1' });
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.any(Object),
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

  it('returns billing_configuration_invalid and marks operation failed when the Stripe price is missing', async () => {
    mockGetStripeSecret.mockResolvedValue({});
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await handler(event());

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_configuration_invalid' });
    expect(customerCreate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = CASE WHEN $3 THEN 'failed' ELSE status END"),
      expect.arrayContaining(['stripe_price_missing', true]),
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

  it('commits the operation transaction before calling Stripe and stores the cached session response', async () => {
    const calls: string[] = [];
    query.mockImplementation((sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT id, email FROM users')) return Promise.resolve({ rows: [{ id: 'user-1', email: 'e@example.com' }] });
      if (sql.includes('SELECT code FROM billing_plans')) return Promise.resolve({ rows: [{ code: 'employer_pro' }] });
      if (sql.includes('SELECT provider_customer_id FROM billing_customers')) return Promise.resolve({ rows: [{ provider_customer_id: 'cus_123' }] });
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
      { email: 'e@example.com', metadata: { userId: 'user-1' } },
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
    expect(mockSetRlsContext).toHaveBeenCalledTimes(3);
  });
});
