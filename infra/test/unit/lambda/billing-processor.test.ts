/**
 * Tests for infra/lambda/billing/processor.ts
 *
 * Uses synthetic fixtures shaped like 2026-06-24.dahlia Stripe events.
 * All IDs are fake (evt_test*, sub_test*, cus_test*, price_test*).
 *
 * Covers:
 *  - duplicate event ID no-op after processed
 *  - failed row is resumable (attempt_count increments)
 *  - two distinct events for same subscription → latest authoritative state applied
 *  - Stripe fetch timeout → row failed + retryable
 *  - DB failure after fetch → SQS retry resumes
 *  - malformed body → failed safe
 *  - unknown event type → skipped
 *  - invoice without parent.subscription_details → retryable failure
 *  - unknown price → failed + safe error
 *  - grace semantics:
 *      fail→sets deadline once
 *      continued past_due→preserves deadline
 *      recover→clears
 *      fail again→new deadline
 *  - exact processed/failure field assertions
 *  - unknown customer → terminal skip (row + SQS message both terminal)
 *  - handler(): SQS message disposition per outcome (delete vs. redeliver)
 */

import type { Context, SQSEvent } from 'aws-lambda';
import { handler, processEnvelope } from '../../../lambda/billing/processor';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/lib/stripe-client');
jest.mock('../../../lambda/lib/entitlements');
jest.mock('../../../lambda/lib/email-outbox');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbMod = require('../../../lambda/lib/db');
const mockGetDbPool: jest.Mock = dbMod.getDbPool;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stripeMod = require('../../../lambda/lib/stripe-client');
const mockGetStripe: jest.Mock = stripeMod.getStripe;
const mockGetStripeSecret: jest.Mock = stripeMod.getStripeSecret;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockResolveEntitlements: jest.Mock = require('../../../lambda/lib/entitlements').resolveEntitlements;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockQueueEmail: jest.Mock = require('../../../lambda/lib/email-outbox').queueEmail;

// ── Fake IDs ───────────────────────────────────────────────────────────────

const EVT1 = 'evt_test000';
const EVT2 = 'evt_test001';
const SUB1 = 'sub_test000';
const CUS1 = 'cus_test000';
const PRICE_PRO = 'price_test000';
const USER1 = 'user-uuid-0001';

// ── Synthetic event factories (2026-06-24.dahlia shape) ────────────────────

function makeSubEvent(overrides: {
  id?: string;
  type?: string;
  subId?: string;
  cusId?: string;
  status?: string;
  priceId?: string;
}): string {
  const id = overrides.id ?? EVT1;
  const type = overrides.type ?? 'customer.subscription.created';
  const subId = overrides.subId ?? SUB1;
  const cusId = overrides.cusId ?? CUS1;
  const status = overrides.status ?? 'active';
  const priceId = overrides.priceId ?? PRICE_PRO;
  return JSON.stringify({
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: subId,
        object: 'subscription',
        customer: cusId,
        status,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: 'si_test000',
              object: 'subscription_item',
              price: { id: priceId },
              current_period_start: 1_700_000_000,
              current_period_end:   1_702_592_000,
            },
          ],
        },
      },
    },
  });
}

function makeInvoiceEvent(overrides: {
  id?: string;
  type?: string;
  parentType?: string;
  subId?: string | null;
}): string {
  const id = overrides.id ?? EVT1;
  const type = overrides.type ?? 'invoice.payment_succeeded';
  const parentType = overrides.parentType ?? 'subscription_details';
  const subId = overrides.subId !== undefined ? overrides.subId : SUB1;
  const parent: Record<string, unknown> = {
    type: parentType,
  };
  if (parentType === 'subscription_details') {
    parent.subscription_details = subId ? { subscription: subId } : {};
  } else {
    parent.quote_details = { quote: 'qt_test000' };
  }
  return JSON.stringify({
    id,
    object: 'event',
    type,
    data: {
      object: {
        id: 'in_test000',
        object: 'invoice',
        parent,
      },
    },
  });
}

function makeEnvelope(rawJson: string, eventId?: string, eventType?: string) {
  let parsedId = eventId;
  let parsedType = eventType;
  if (!parsedId || !parsedType) {
    const parsed = JSON.parse(rawJson);
    parsedId = parsedId ?? parsed.id;
    parsedType = parsedType ?? parsed.type;
  }
  return {
    eventId: parsedId!,
    eventType: parsedType!,
    receivedAt: new Date().toISOString(),
    rawBody: Buffer.from(rawJson, 'utf8').toString('base64'),
  };
}

// ── DB mock helpers ────────────────────────────────────────────────────────

/** Mock a DB pool with full query tracking */
function makeDbMock(queryResponses?: Map<string, unknown[]>) {
  const queryMock = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (queryResponses) {
      for (const [key, rows] of queryResponses) {
        if (sql.includes(key)) {
          return Promise.resolve({ rows });
        }
      }
    }
    return Promise.resolve({ rows: [] });
  });
  const releaseMock = jest.fn();
  const clientMock = { query: queryMock, release: releaseMock };
  const poolMock = {
    query: queryMock,
    connect: jest.fn().mockResolvedValue(clientMock),
  };
  mockGetDbPool.mockResolvedValue(poolMock);
  return { queryMock, releaseMock, clientMock, poolMock };
}

/** Minimal authoritative subscription returned by Stripe */
function makeStripeSubscription(overrides: {
  id?: string;
  status?: string;
  customerId?: string;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
} = {}): unknown {
  return {
    id: overrides.id ?? SUB1,
    object: 'subscription',
    status: overrides.status ?? 'active',
    customer: overrides.customerId ?? CUS1,
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    items: {
      data: [
        {
          id: 'si_test000',
          object: 'subscription_item',
          price: { id: overrides.priceId ?? PRICE_PRO },
          current_period_start: 1_700_000_000,
          current_period_end:   1_702_592_000,
        },
      ],
    },
  };
}

function mockStripe(subscription: unknown) {
  const retrieve = jest.fn().mockResolvedValue(subscription);
  mockGetStripe.mockResolvedValue({ subscriptions: { retrieve } });
  return { retrieve };
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('billing processor: processEnvelope()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    // FIX 1: price comes from stripe secret, not env var
    mockGetStripeSecret.mockResolvedValue({ secretKey: 'rk_test_000', priceIdEmployerPro: PRICE_PRO });
    mockResolveEntitlements.mockResolvedValue({ planCode: 'employer_free', activeJobLimit: 1 });
    mockQueueEmail.mockResolvedValue('email-outbox-1');
  });

  function setupEntitlementReduction(
    pausedCount: number,
    pausedTitles: string[] = [],
    employerEmail: string | null = 'employer@example.com',
  ) {
    const { queryMock } = makeDbMock();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
      if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [{ id: 'subscription-row-uuid' }] });
      if (sql.includes('billing_pause_over_limit_jobs')) return Promise.resolve({ rows: [{
        paused_count: pausedCount,
        employer_email: employerEmail,
        paused_titles: pausedTitles,
      }] });
      return Promise.resolve({ rows: [] });
    });
    return { queryMock };
  }

  it.each(['canceled', 'unpaid', 'incomplete_expired', 'paused'])(
    'enforces the resolved active-job limit for reducing status %s',
    async (status) => {
      const { queryMock } = setupEntitlementReduction(0);
      mockStripe(makeStripeSubscription({ status }));
      const result = await processEnvelope(makeEnvelope(makeSubEvent({ status })));
      expect(result.outcome).toBe('processed');
      expect(mockResolveEntitlements).toHaveBeenCalledWith(expect.anything(), USER1);
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('billing_pause_over_limit_jobs'),
        [USER1, 1],
      );
      expect(mockQueueEmail).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'trialing', 'past_due'])(
    'does not enforce or email for non-reducing/grace status %s',
    async (status) => {
      const { queryMock } = setupEntitlementReduction(2, ['Newest job']);
      mockStripe(makeStripeSubscription({ status }));
      const result = await processEnvelope(makeEnvelope(makeSubEvent({ status })));
      expect(result.outcome).toBe('processed');
      expect(mockResolveEntitlements).not.toHaveBeenCalled();
      expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('billing_pause_over_limit_jobs'))).toBe(false);
      expect(mockQueueEmail).not.toHaveBeenCalled();
    },
  );

  it('queues one bilingual email atomically with exact subscription/event idempotency', async () => {
    const infoLog = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    setupEntitlementReduction(2, ['Older overflow', 'Newest overflow']);
    mockStripe(makeStripeSubscription({ status: 'canceled' }));
    const result = await processEnvelope(makeEnvelope(makeSubEvent({ status: 'canceled' })));
    expect(result.outcome).toBe('processed');
    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    expect(mockQueueEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      recipientEmail: 'employer@example.com',
      sourceType: 'billing_pause',
      sourceId: 'subscription-row-uuid',
      idempotencyKey: `billing-pause:subscription-row-uuid:${EVT1}`,
      bodyText: expect.stringMatching(/Older overflow[\s\S]*https:\/\/jaleapp\.ai\/en\/employer\/billing[\s\S]*Tu suscripción[\s\S]*https:\/\/jaleapp\.ai\/es\/employer\/billing/),
    }));
    expect(infoLog).toHaveBeenCalledWith('paused_over_limit_jobs', { userId: USER1, pausedCount: 2 });
    infoLog.mockRestore();
  });

  it.each([
    { name: 'missing employer email', count: 1, titles: ['Overflow'], email: null,
      code: 'billing_job_enforcement_invalid_email' },
    { name: 'title count mismatch', count: 2, titles: ['Only one'], email: 'employer@example.com',
      code: 'billing_job_enforcement_invalid_titles' },
    { name: 'blank title', count: 1, titles: ['   '], email: 'employer@example.com',
      code: 'billing_job_enforcement_invalid_titles' },
  ])('rolls back on $name', async ({ count, titles, email, code }) => {
    const { queryMock } = setupEntitlementReduction(count, titles, email);
    mockStripe(makeStripeSubscription({ status: 'canceled' }));
    await expect(processEnvelope(makeEnvelope(makeSubEvent({ status: 'canceled' }))))
      .resolves.toEqual({ outcome: 'failed', errorCode: code });
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('rolls back when the enforcement function returns no result row', async () => {
    const { queryMock } = setupEntitlementReduction(0);
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
      if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [{ id: 'subscription-row-uuid' }] });
      if (sql.includes('billing_pause_over_limit_jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    mockStripe(makeStripeSubscription({ status: 'canceled' }));

    await expect(processEnvelope(makeEnvelope(makeSubEvent({ status: 'canceled' }))))
      .resolves.toEqual({ outcome: 'failed', errorCode: 'billing_job_enforcement_invalid_result' });
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQueueEmail).not.toHaveBeenCalled();
  });

  it('rolls back subscription, enforcement, and email together when queueing fails', async () => {
    const { queryMock } = setupEntitlementReduction(1, ['Newest overflow']);
    mockQueueEmail.mockRejectedValue(new Error('email_outbox_insert_failed'));
    mockStripe(makeStripeSubscription({ status: 'canceled' }));
    const result = await processEnvelope(makeEnvelope(makeSubEvent({ status: 'canceled' })));
    expect(result).toEqual({ outcome: 'failed', errorCode: 'email_outbox_insert_failed' });
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    const queueOrder = mockQueueEmail.mock.invocationCallOrder[0];
    const rollbackCall = queryMock.mock.calls.findIndex(([sql]) => sql === 'ROLLBACK');
    expect(rollbackCall).toBeGreaterThan(-1);
    expect(queueOrder).toBeLessThan(queryMock.mock.invocationCallOrder[rollbackCall]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── Duplicate terminal no-op ─────────────────────────────────────────

  it('returns duplicate_terminal and does NOT call Stripe for an already-processed event', async () => {
    const responses = new Map<string, unknown[]>([
      ['billing_customers', [{ user_id: USER1 }]],
    ]);
    const { queryMock } = makeDbMock(responses);

    // Simulate: INSERT does nothing (row existed), SELECT returns processed row
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'processed', attempt_count: 2 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const { retrieve } = mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('duplicate_terminal');
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('returns duplicate_terminal for already-skipped events', async () => {
    const { queryMock } = makeDbMock();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'skipped', attempt_count: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('duplicate_terminal');
  });

  // ── Lease semantics (Important #1 fix): concurrent SQS delivery guard ──

  describe('lease semantics', () => {
    it('a row with a LIVE lease is NOT processed (duplicate_in_progress, no Stripe call)', async () => {
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] }); // pre-existed
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          // The atomic claim UPDATE's WHERE excludes rows with a live lease
          // (lease_expires_at > now()) -> 0 rows updated.
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('SELECT processing_status')) {
          // received/failed, but excluded above because of the live lease.
          return Promise.resolve({ rows: [{ processing_status: 'received' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const { retrieve } = mockStripe(makeStripeSubscription());
      const rawJson = makeSubEvent({ id: EVT1 });
      const result = await processEnvelope(makeEnvelope(rawJson));

      expect(result.outcome).toBe('duplicate_in_progress');
      // Must not touch Stripe or advance processing while another delivery
      // holds a live lease.
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('a "failed" row with a LIVE lease is also NOT resumed (in-progress duplicate, not terminal)', async () => {
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('SELECT processing_status')) {
          return Promise.resolve({ rows: [{ processing_status: 'failed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const { retrieve } = mockStripe(makeStripeSubscription());
      const rawJson = makeSubEvent({ id: EVT1 });
      const result = await processEnvelope(makeEnvelope(rawJson));

      expect(result.outcome).toBe('duplicate_in_progress');
      expect(retrieve).not.toHaveBeenCalled();
    });

    it('a row with an EXPIRED (or NULL) lease is resumed and processed normally', async () => {
      const claimCalls: { sql: string; params: unknown[] }[] = [];
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] }); // pre-existed
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          claimCalls.push({ sql, params });
          // Lease is expired (or NULL) -> the atomic claim UPDATE's WHERE
          // matches -> 1 row updated, fresh lease set.
          return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
        }
        if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
        if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      mockStripe(makeStripeSubscription());
      const rawJson = makeSubEvent({ id: EVT1 });
      const result = await processEnvelope(makeEnvelope(rawJson));

      expect(result.outcome).toBe('processed');
      expect(claimCalls.length).toBe(1);
      // The claim query must guard on the lease being NULL or expired, and
      // must set a fresh lease on success.
      expect(claimCalls[0].sql).toContain('lease_expires_at IS NULL OR lease_expires_at < now()');
      expect(claimCalls[0].sql).toContain('lease_expires_at = now()');
    });

    it('a "failed" row (no live lease) is resumed with a fresh lease and processed', async () => {
      const claimCalls: { sql: string; params: unknown[] }[] = [];
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          claimCalls.push({ sql, params });
          return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
        }
        if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
        if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
      });

      mockStripe(makeStripeSubscription());
      const rawJson = makeSubEvent({ id: EVT1 });
      const result = await processEnvelope(makeEnvelope(rawJson));

      expect(result.outcome).toBe('processed');
      expect(claimCalls.length).toBe(1);
      expect(claimCalls[0].sql).toContain("processing_status IN ('received', 'failed')");
    });

    it('marking a row processed clears the lease (lease_expires_at = NULL)', async () => {
      const processedMarkCalls: { sql: string; params: unknown[] }[] = [];
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
        }
        if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
        if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
        if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processed_at')) {
          processedMarkCalls.push({ sql, params });
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      mockStripe(makeStripeSubscription());
      const rawJson = makeSubEvent({ id: EVT1 });
      const result = await processEnvelope(makeEnvelope(rawJson));

      expect(result.outcome).toBe('processed');
      expect(processedMarkCalls.length).toBe(1);
      expect(processedMarkCalls[0].sql).toContain('lease_expires_at  = NULL');
    });
  });

  // ── FIX 2: attempt_count accounting ──────────────────────────────────

  it('FIX2: fresh claim leaves attempt_count=1 (no UPDATE increment)', async () => {
    const attemptUpdates: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      // Fresh INSERT returns a row (inserted = true)
      if (sql.includes('INSERT INTO billing_webhook_events') && sql.includes('RETURNING stripe_event_id')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
      }
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        attemptUpdates.push(params);
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('processed');
    // No attempt_count UPDATE should have fired for a fresh claim
    expect(attemptUpdates.length).toBe(0);
  });

  it('FIX2: resume after failed increments attempt_count to exactly 2 (via SQL attempt_count + 1)', async () => {
    const attemptUpdates: { sql: string; params: unknown[] }[] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      // INSERT returns nothing = row pre-existed
      if (sql.includes('INSERT INTO billing_webhook_events') && sql.includes('RETURNING stripe_event_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        attemptUpdates.push({ sql, params });
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) return Promise.resolve({ rows: [{ user_id: USER1 }] });
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('processed');
    // Should have fired exactly one atomic claim UPDATE that increments
    // attempt_count in SQL (attempt_count = attempt_count + 1), not via a
    // JS-computed literal — the row's prior attempt_count is never read
    // by the claim path (only the atomic UPDATE ... RETURNING result matters).
    expect(attemptUpdates.length).toBe(1);
    expect(attemptUpdates[0].sql).toContain('attempt_count = attempt_count + 1');
    expect(attemptUpdates[0].params).toContain(EVT1);
  });

  it('FIX2: duplicate of processed row is terminal no-op (claim UPDATE affects 0 rows)', async () => {
    const attemptUpdates: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] }); // pre-existed
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        attemptUpdates.push(params);
        // processing_status='processed' is excluded by the claim UPDATE's WHERE clause -> 0 rows
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'processed' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const { retrieve } = mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('duplicate_terminal');
    expect(retrieve).not.toHaveBeenCalled();
    // The atomic claim UPDATE is attempted but affects 0 rows for a terminal status
    expect(attemptUpdates.length).toBe(1);
  });

  // ── Failed row is resumable ───────────────────────────────────────────

  it('increments attempt_count for a failed row and processes it', async () => {
    const { queryMock } = makeDbMock();
    const updateCalls: { sql: string; params: unknown[] }[] = [];

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'failed', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        updateCalls.push({ sql, params });
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      // subscriptions upsert
      if (sql.includes('INSERT INTO subscriptions')) return Promise.resolve({ rows: [] });
      // inbox final mark
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        return Promise.resolve({ rows: [] });
      }
      // billing_customers lookup
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      // subscriptions FOR UPDATE (existing row check)
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] }); // no existing row
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    // attempt_count should have been incremented atomically in SQL
    const attemptUpdate = updateCalls.find(c => c.sql.includes('attempt_count'));
    expect(attemptUpdate).toBeDefined();
    expect(attemptUpdate!.sql).toContain('attempt_count = attempt_count + 1');
    expect(attemptUpdate!.params).toContain(EVT1);

    // Should succeed
    expect(result.outcome).toBe('processed');
  });

  // ── Two distinct events for same subscription ─────────────────────────

  it('applies authoritative Stripe state for a second event on the same subscription', async () => {
    // Both EVT1 and EVT2 target SUB1; EVT2 should fetch current state and upsert
    const insertedRows: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        // No existing row → fresh insert path (attempt_count already set to 1)
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] }); // no existing row
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        insertedRows.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Both events → fetch returns active subscription (authoritative)
    const activeStripe = makeStripeSubscription({ status: 'active' });
    const retrieve = jest.fn().mockResolvedValue(activeStripe);
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve } });

    const rawJson1 = makeSubEvent({ id: EVT1, type: 'customer.subscription.created', subId: SUB1 });
    const rawJson2 = makeSubEvent({ id: EVT2, type: 'customer.subscription.updated', subId: SUB1 });

    const r1 = await processEnvelope(makeEnvelope(rawJson1));
    const r2 = await processEnvelope(makeEnvelope(rawJson2));

    expect(r1.outcome).toBe('processed');
    expect(r2.outcome).toBe('processed');
    // Stripe was fetched authoritatively for each event
    expect(retrieve).toHaveBeenCalledTimes(2);
    // Both should have upserted the subscriptions row
    expect(insertedRows.length).toBeGreaterThanOrEqual(2);
  });

  // ── Stripe fetch timeout → row failed + retryable ──────────────────────

  it('marks inbox as failed when Stripe fetch throws (timeout scenario)', async () => {
    const failedMarkParams: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      // Capture failed mark
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        failedMarkParams.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Stripe fetch throws
    const retrieve = jest.fn().mockRejectedValue(new Error('connection timeout'));
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve } });

    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('stripe_fetch_failed');

    // Verify the DB was marked failed with a safe error code
    const failedMark = failedMarkParams.find(p => Array.isArray(p) && p.includes('failed'));
    expect(failedMark).toBeDefined();
    expect(failedMark).toContain(EVT1);
    expect(failedMark).toContain('failed');
  });

  // ── Malformed body → failed safe ──────────────────────────────────────

  it('marks inbox failed for a malformed base64/JSON body without crashing', async () => {
    const { queryMock } = makeDbMock();
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve: jest.fn() } });

    const badEnvelope = {
      eventId: EVT1,
      eventType: 'customer.subscription.created',
      receivedAt: new Date().toISOString(),
      rawBody: Buffer.from('not valid json!!!', 'utf8').toString('base64'),
    };

    const result = await processEnvelope(badEnvelope);
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('malformed_envelope');
  });

  it('malformed-envelope failure upsert never reopens a terminal processed/skipped row', async () => {
    const upsertSqls: string[] = [];
    const { queryMock } = makeDbMock();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) upsertSqls.push(sql);
      return Promise.resolve({ rows: [] });
    });
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve: jest.fn() } });

    await processEnvelope({
      eventId: EVT1,
      eventType: 'customer.subscription.created',
      receivedAt: new Date().toISOString(),
      rawBody: Buffer.from('not valid json!!!', 'utf8').toString('base64'),
    });

    // The claim path guards terminal rows; the fallback failure upsert must too,
    // or a corrupted re-delivery of an already-processed event would flip a
    // terminal 'processed' row back to 'failed' and reopen it for reprocessing.
    expect(upsertSqls.length).toBeGreaterThan(0);
    for (const sql of upsertSqls) {
      expect(sql).toMatch(/WHERE billing_webhook_events\.processing_status NOT IN \('processed', 'skipped'\)/);
    }
  });

  // ── Unknown event type → skipped ──────────────────────────────────────

  it('marks unknown event types as skipped and does NOT call Stripe', async () => {
    const skippedParams: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        skippedParams.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const retrieve = jest.fn();
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve } });

    const rawJson = JSON.stringify({
      id: EVT1,
      object: 'event',
      type: 'some.unknown.event.type',
      data: { object: { id: 'obj_001' } },
    });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('skipped');
    expect(retrieve).not.toHaveBeenCalled();

    // Verify it was marked skipped in DB
    const skippedMark = skippedParams.find(p => Array.isArray(p) && p.includes('skipped'));
    expect(skippedMark).toBeDefined();
    expect(skippedMark).toContain(EVT1);
  });

  it('skips invoice.finalized events', async () => {
    const { queryMock } = makeDbMock();
    const statusUpdates: string[] = [];

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        if (Array.isArray(params)) statusUpdates.push(...params.filter(p => typeof p === 'string'));
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const retrieve = jest.fn();
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve } });

    const rawJson = JSON.stringify({
      id: EVT1,
      object: 'event',
      type: 'invoice.finalized',
      data: { object: { id: 'in_test000', object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: SUB1 } } } },
    });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('skipped');
    expect(retrieve).not.toHaveBeenCalled();
    expect(statusUpdates).toContain('skipped');
  });

  // ── Invoice without parent.subscription_details → retryable failure ───

  it('fails invoice event when parent.type is not subscription_details', async () => {
    const failedMarks: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        failedMarks.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve: jest.fn() } });

    const rawJson = makeInvoiceEvent({ id: EVT1, type: 'invoice.payment_succeeded', parentType: 'quote_details' });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('invoice_subscription_id_missing');

    const failedMark = failedMarks.find(p => Array.isArray(p) && p.includes('failed'));
    expect(failedMark).toBeDefined();
    expect(failedMark).toContain('invoice_subscription_id_missing');
  });

  it('fails invoice event when subscription_details.subscription is missing', async () => {
    const { queryMock } = makeDbMock();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      return Promise.resolve({ rows: [] });
    });
    mockGetStripe.mockResolvedValue({ subscriptions: { retrieve: jest.fn() } });

    const rawJson = makeInvoiceEvent({ id: EVT1, type: 'invoice.payment_succeeded', subId: null });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('invoice_subscription_id_missing');
  });

  // ── FIX 1: billing_configuration_invalid when priceIdEmployerPro missing from secret ──

  it('fails with billing_configuration_invalid when priceIdEmployerPro is absent from the stripe secret', async () => {
    const failedMarks: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        failedMarks.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Secret has no priceIdEmployerPro
    mockGetStripeSecret.mockResolvedValue({ secretKey: 'rk_test_000' });
    mockStripe(makeStripeSubscription());

    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('billing_configuration_invalid');

    const failedMark = failedMarks.find(p => Array.isArray(p) && p.includes('failed'));
    expect(failedMark).toBeDefined();
    expect(failedMark).toContain('billing_configuration_invalid');
  });

  it('fails with billing_configuration_invalid when priceIdEmployerPro is empty string in the stripe secret', async () => {
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('UPDATE billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Secret has empty priceIdEmployerPro
    mockGetStripeSecret.mockResolvedValue({ secretKey: 'rk_test_000', priceIdEmployerPro: '' });
    mockStripe(makeStripeSubscription());

    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('billing_configuration_invalid');
  });

  // ── Unknown price → failed + safe error ──────────────────────────────

  it('fails with unknown_price when subscription item price does not match configured price', async () => {
    const failedMarks: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        failedMarks.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Stripe returns subscription with a DIFFERENT price ID
    mockStripe(makeStripeSubscription({ priceId: 'price_different_999' }));

    const rawJson = makeSubEvent({ id: EVT1, priceId: 'price_different_999' });
    const result = await processEnvelope(makeEnvelope(rawJson));

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('unknown_price');

    const failedMark = failedMarks.find(p => Array.isArray(p) && p.includes('failed'));
    expect(failedMark).toBeDefined();
    expect(failedMark).toContain('unknown_price');
  });

  it('terminally SKIPS (never fails) when billing_customers has no matching row', async () => {
    const marks: unknown[][] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [] }); // no customer mapping
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        marks.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());

    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));

    // An unmapped Stripe customer is permanently unactionable, so 'failed'
    // would only burn 3 SQS receives and land the event in the DLQ, firing
    // BillingWebhookDlqDepth for something no redrive can ever fix.
    expect(result).toEqual({ outcome: 'skipped', errorCode: 'unknown_customer' });
    expect(marks.some((p) => Array.isArray(p) && p.includes('failed'))).toBe(false);

    const skippedMark = marks.find(p => Array.isArray(p) && p.includes('skipped'));
    expect(skippedMark).toBeDefined();
    expect(skippedMark).toContain('unknown_customer');

    // This log line is the ONLY signal for the skip (nothing else reads
    // billing_webhook_events). BillingStack greps this exact literal out of
    // the processor log group into Jale/Billing/BillingUnknownCustomerSkipped,
    // so the string is a cross-file contract — assert it literally.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('billing_unknown_customer_skipped');
    expect(String(warn.mock.calls[0][0])).toContain(EVT1);
    warn.mockRestore();
  });

  // ── Grace semantics with explicit timestamps ──────────────────────────

  describe('grace_ends_at semantics', () => {
    /**
     * We test the grace logic by examining the parameters passed to the
     * INSERT INTO subscriptions... ON CONFLICT query.
     */

    function setupDbForGrace(existingSubRow?: {
      status: string;
      grace_ends_at: string | null;
    }) {
      const insertParams: unknown[][] = [];
      const { queryMock } = makeDbMock();

      queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT processing_status')) {
          return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
        }
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
          return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
        }
        if (sql.includes('billing_customers')) {
          return Promise.resolve({ rows: [{ user_id: USER1 }] });
        }
        if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: existingSubRow ? [existingSubRow] : [] });
        }
        if (sql.includes('INSERT INTO subscriptions')) {
          insertParams.push(params);
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      return { insertParams };
    }

    it('sets grace_ends_at (null param → SQL uses now()+7d) on first transition into past_due', async () => {
      // No existing row
      const { insertParams } = setupDbForGrace(undefined);
      mockStripe(makeStripeSubscription({ status: 'past_due' }));

      const rawJson = makeSubEvent({ id: EVT1, type: 'customer.subscription.updated' });
      const result = await processEnvelope(makeEnvelope(rawJson));
      expect(result.outcome).toBe('processed');

      // Parameter $8 (index 7) should be null — SQL expression sets now()+7d
      expect(insertParams.length).toBeGreaterThan(0);
      const p = insertParams[0];
      // $4 = status = 'past_due', $8 = graceFragment = null
      expect(p[3]).toBe('past_due');
      expect(p[7]).toBeNull();
    });

    it('preserves grace_ends_at when status stays past_due', async () => {
      const existingGrace = '2026-08-14T00:00:00.000Z';
      const { insertParams } = setupDbForGrace({
        status: 'past_due',
        grace_ends_at: existingGrace,
      });
      mockStripe(makeStripeSubscription({ status: 'past_due' }));

      const rawJson = makeSubEvent({ id: EVT1, type: 'customer.subscription.updated' });
      const result = await processEnvelope(makeEnvelope(rawJson));
      expect(result.outcome).toBe('processed');

      expect(insertParams.length).toBeGreaterThan(0);
      const p = insertParams[0];
      // $4 = 'past_due', $8 = existing grace timestamp (preserved)
      expect(p[3]).toBe('past_due');
      expect(p[7]).toBe(existingGrace);
    });

    it('clears grace_ends_at (null) on recovery to active', async () => {
      const { insertParams } = setupDbForGrace({
        status: 'past_due',
        grace_ends_at: '2026-08-14T00:00:00.000Z',
      });
      // Stripe now returns active
      mockStripe(makeStripeSubscription({ status: 'active' }));

      const rawJson = makeSubEvent({ id: EVT1, type: 'customer.subscription.updated' });
      const result = await processEnvelope(makeEnvelope(rawJson));
      expect(result.outcome).toBe('processed');

      expect(insertParams.length).toBeGreaterThan(0);
      const p = insertParams[0];
      // $4 = 'active', $8 = null (cleared)
      expect(p[3]).toBe('active');
      expect(p[7]).toBeNull();
    });

    it('sets a NEW grace_ends_at after recovery then re-failure', async () => {
      // First: recovered to active → grace cleared
      // Then: fails to past_due again → new null param → SQL sets new deadline
      const { insertParams } = setupDbForGrace(undefined); // no existing row (cleared)
      mockStripe(makeStripeSubscription({ status: 'past_due' }));

      const rawJson = makeSubEvent({ id: EVT2, type: 'customer.subscription.updated' });
      const result = await processEnvelope(makeEnvelope(rawJson));
      expect(result.outcome).toBe('processed');

      // $8 should be null → SQL expression generates new now()+7d deadline
      const p = insertParams[0];
      expect(p[3]).toBe('past_due');
      expect(p[7]).toBeNull(); // signals SQL will set new deadline
    });
  });

  // ── Exact processed/failure field assertions ──────────────────────────

  it('marks processed_at with non-null timestamp when event is successfully processed', async () => {
    const processedMarkParams: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        processedMarkParams.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription({ status: 'active' }));
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('processed');

    // Find the mark with 'processed' status
    const processedMark = processedMarkParams.find(p => Array.isArray(p) && p.includes('processed'));
    expect(processedMark).toBeDefined();
    // Parameters: $1=eventId, $2=status, $3=errorCode, $4=processedAt
    expect(processedMark![0]).toBe(EVT1);
    expect(processedMark![1]).toBe('processed');
    expect(processedMark![2]).toBeNull();
    expect(processedMark![3]).toBeInstanceOf(Date);
  });

  it('marks processing_status=skipped with the unknown_customer code and a decision timestamp', async () => {
    const markParams: unknown[][] = [];
    // Silences the metric line only; its content is asserted above.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [] }); // no customer
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('processing_status')) {
        markParams.push(params);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('skipped');

    // Exact parameter check: $1=eventId, $2='skipped', $3='unknown_customer',
    // $4=<Date>. The last two are deliberate deviations from every other
    // 'skipped' write in this processor (which passes null/null): the error
    // code keeps the reason forensically recoverable from the inbox row, and
    // processed_at records WHEN we terminally decided — not that we mirrored
    // any Stripe state.
    const mark = markParams.find(p => Array.isArray(p) && p.includes('skipped'));
    expect(mark).toBeDefined();
    expect(mark![0]).toBe(EVT1);
    expect(mark![1]).toBe('skipped');
    expect(mark![2]).toBe('unknown_customer');
    expect(mark![3]).toBeInstanceOf(Date);
    warn.mockRestore();
  });

  // ── handler(): SQS message disposition ────────────────────────────────
  //
  // A ProcessResult only reaches production behavior through the SQS handler.
  // With reportBatchItemFailures on a batchSize-1 source, a resolved void
  // return reports no failed items → the message is DELETED; a throw →
  // redelivery, and after maxReceiveCount=3 the DLQ (BillingWebhookDlqDepth).
  // These two cases pin that boundary, which is what makes the
  // unknown_customer skip terminal at the *message* level and not just at the
  // row level.
  describe('handler() SQS message disposition', () => {
    /** The handler reads only `record.body`; the rest of the SQS shape is noise here. */
    function invoke(rawJson: string): Promise<unknown> {
      const sqsEvent = {
        Records: [{
          messageId: 'msg-0001',
          eventSource: 'aws:sqs',
          body: JSON.stringify(makeEnvelope(rawJson)),
        }],
      } as unknown as SQSEvent;
      return Promise.resolve(handler(sqsEvent, {} as Context, () => undefined));
    }

    /** Fresh inbox claim (INSERT returns a row), then the given customer lookup + price. */
    function setupInbox(customerRows: unknown[], priceId: string) {
      const { queryMock } = makeDbMock();
      queryMock.mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO billing_webhook_events')) {
          return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] });
        }
        if (sql.includes('billing_customers')) return Promise.resolve({ rows: customerRows });
        return Promise.resolve({ rows: [] });
      });
      mockStripe(makeStripeSubscription({ priceId }));
      return { queryMock };
    }

    it('resolves (message deleted) for the terminal unknown_customer skip', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      setupInbox([], PRICE_PRO);

      // Void resolution — not a { batchItemFailures } response — is what tells
      // SQS the whole batch succeeded and the message can go away.
      await expect(invoke(makeSubEvent({ id: EVT1 }))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('billing_unknown_customer_skipped');
      warn.mockRestore();
    });

    it('throws (message redelivered → DLQ) for a failed outcome such as unknown_price', async () => {
      setupInbox([{ user_id: USER1 }], 'price_different_999');

      await expect(invoke(makeSubEvent({ id: EVT1, priceId: 'price_different_999' })))
        .rejects.toThrow('unknown_price');
    });
  });

  // ── DB failure after Stripe fetch → SQS retry resumes ────────────────

  it('throws so SQS can retry when DB fails during the final mirror transaction', async () => {
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        throw new Error('DB connection lost');
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription());
    const rawJson = makeSubEvent({ id: EVT1 });

    const result = await processEnvelope(makeEnvelope(rawJson));
    // DB error after Stripe fetch → outer catch marks failed so SQS retries
    expect(result.outcome).toBe('failed');
  });

  // ── checkout.session.completed ────────────────────────────────────────

  it('processes checkout.session.completed when subscription ID is present', async () => {
    const insertedSubs: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        insertedSubs.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE billing_webhook_events')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription({ status: 'active' }));

    const rawJson = JSON.stringify({
      id: EVT1,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test000',
          object: 'checkout.session',
          subscription: SUB1,
          customer: CUS1,
        },
      },
    });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('processed');
    expect(insertedSubs.length).toBeGreaterThan(0);
  });

  // ── Invoice payment_succeeded with valid parent ────────────────────────

  it('processes invoice.payment_succeeded with valid subscription_details parent', async () => {
    const insertedSubs: unknown[][] = [];
    const { queryMock } = makeDbMock();

    queryMock.mockImplementation((sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO billing_webhook_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('SELECT processing_status')) {
        return Promise.resolve({ rows: [{ processing_status: 'received', attempt_count: 1 }] });
      }
      if (sql.includes('UPDATE billing_webhook_events') && sql.includes('attempt_count')) {
        return Promise.resolve({ rows: [{ stripe_event_id: EVT1 }] }); // claim succeeds
      }
      if (sql.includes('billing_customers')) {
        return Promise.resolve({ rows: [{ user_id: USER1 }] });
      }
      if (sql.includes('FROM subscriptions') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        insertedSubs.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE billing_webhook_events')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockStripe(makeStripeSubscription({ status: 'active' }));

    const rawJson = makeInvoiceEvent({ id: EVT1, type: 'invoice.payment_succeeded' });
    const result = await processEnvelope(makeEnvelope(rawJson));
    expect(result.outcome).toBe('processed');
    expect(insertedSubs.length).toBeGreaterThan(0);
  });
});
