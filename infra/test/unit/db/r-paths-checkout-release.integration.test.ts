/**
 * r-paths-checkout-release.integration.test.ts
 *
 * The pooled-client release rule on the failure path of POST /billing/checkout
 * (lambda/billing/checkout.ts). When a billing helper fails on SQL inside its
 * own transaction, the handler's catch tries to record the failure on the
 * same client -- that helper's BEGIN is refused (25P02) and the error is
 * swallowed -- and `finally` releases a client that is still inside an
 * aborted transaction. Every pool lib/db builds destroys such a client
 * instead of handing it to the next request.
 *
 * Driven on a real PostgreSQL bed, over a real jale_api connection, with
 * Stripe mocked and persistBillingCustomer replaced by one that fails the way
 * a missing grant does (42501) inside its transaction. recordCheckoutFailure
 * is the real one. The checks:
 *   - the response is today's answer for that failure (a retryable 503);
 *   - the released client is destroyed: the pool holds no connection
 *     afterwards, the next checkout is a different backend, idle, and usable;
 *   - negative control: the same flow on an unguarded pool hands the aborted
 *     connection to the next caller, whose first statement then fails.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { loginPool, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  test('CONCERN: the checkout release DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

let mockPool: Pool | undefined;
let failingBackendPid: number | undefined;

jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

jest.mock('../../../lambda/lib/stripe-client', () => {
  const actual = jest.requireActual('../../../lambda/lib/stripe-client');
  return {
    ...actual,
    getStripeSecret: async () => ({ priceIdEmployerPro: 'fixture-price' }),
    getStripe: async () => ({
      customers: { create: async () => ({ id: 'fixture-customer' }) },
      checkout: { sessions: { create: async () => { throw new Error('the session must never be created'); } } },
    }),
  };
});

jest.mock('../../../lambda/lib/billing-operations', () => {
  const actual = jest.requireActual('../../../lambda/lib/billing-operations');
  return {
    ...actual,
    prepareCheckoutOperation: async () => ({
      kind: 'ready',
      operationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      email: null,
      planCode: 'employer_pro',
      requestHash: 'fixture-hash',
      customerIdempotencyKey: 'fixture-customer-key',
      checkoutIdempotencyKey: 'fixture-checkout-key',
      existingProviderCustomerId: null,
    }),
    // Fails inside its own transaction, exactly as a statement refused for a
    // missing grant would: pg_authid is readable by superusers only.
    persistBillingCustomer: async (client: PoolClient) => {
      await client.query('BEGIN');
      failingBackendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('SELECT rolname FROM pg_catalog.pg_authid LIMIT 1');
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/billing/checkout');

function checkoutEvent() {
  return {
    requestContext: { authorizer: { claims: { sub: `fixture-employer-${randomUUID()}` } } },
    headers: { 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      planCode: 'employer_pro',
      successUrl: 'http://localhost:3000/billing/success',
      cancelUrl: 'http://localhost:3000/billing/cancel',
    }),
  };
}

async function nextClientPid(pool: Pool): Promise<{ pid: number | undefined; status: string | null; error?: string }> {
  const client = await pool.connect();
  try {
    const status = client.getTransactionStatus();
    try {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return { pid: rows[0].pid, status };
    } catch (err) {
      return { pid: undefined, status, error: (err as { code?: string }).code };
    }
  } finally {
    client.release(true);
  }
}

maybeDescribe('checkout releases its client inside an aborted transaction', () => {
  beforeAll(() => {
    process.env.ALLOWED_ORIGIN = 'http://localhost:3000';
    process.env.REQUIRED_TOS_VERSION = 'fixture-tos-1';
  });
  beforeEach(() => {
    failingBackendPid = undefined;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await mockPool?.end();
    mockPool = undefined;
  });

  it('a pool built by lib/db destroys that client; the next request gets a fresh, idle connection', async () => {
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');

    const response = await handler(checkoutEvent());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'provider_retryable' });
    expect(failingBackendPid).toEqual(expect.any(Number));

    // Destroyed, not parked: nothing is left in the pool.
    expect(mockPool.totalCount).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"db_client_discarded"'));

    const next = await nextClientPid(mockPool);
    expect(next.error).toBeUndefined();
    expect(next.status).toBe('I');
    expect(next.pid).not.toBe(failingBackendPid);
  });

  it('negative control: an unguarded pool hands the aborted connection to the next caller', async () => {
    mockPool = loginPool('jale_api', { max: 1 });

    const response = await handler(checkoutEvent());
    expect(response.statusCode).toBe(503);

    expect(mockPool.totalCount).toBe(1);
    const next = await nextClientPid(mockPool);
    expect(next.status).toBe('E');
    expect(next.error).toBe('25P02');
  });
});
