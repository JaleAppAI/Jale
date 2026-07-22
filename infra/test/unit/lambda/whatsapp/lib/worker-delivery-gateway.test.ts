const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  enqueueWorkerMessage,
  registerCategoryRenderer,
  _clearCategoryRenderersForTests,
} from '../../../../../lambda/whatsapp/lib/worker-delivery-gateway';
import type { WorkerMessageIntentInput, RenderedOutboxMessage } from '../../../../../lambda/whatsapp/lib/onboarding-types';

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function baseInput(overrides: Partial<WorkerMessageIntentInput> = {}): WorkerMessageIntentInput {
  return {
    workerId: WORKER_ID,
    category: 'job_alert',
    ownerService: 'job-alert',
    sourceType: 'job',
    sourceId: 'job-1',
    dedupeKey: 'job_alert:job-1:worker-1',
    priority: 5,
    expiresAt: null,
    payload: {},
    ...overrides,
  };
}

/**
 * A fake PoolClient scripted to answer every query enqueueWorkerMessage /
 * loadWorkerGate / loadRuntimeControls / insertAuthorizedIntentOutbox could
 * issue, matched by SQL substring rather than call order (keeps the test
 * resilient to internal reordering).
 */
function scriptedClient(opts: {
  gateRow?: Record<string, unknown> | null;
  deferredDeliveryEnabled?: boolean;
  intentStatusForOutboxCheck?: string;
  /**
   * outbox_id to RETURN from successive calls to the intent INSERT, in
   * order (simulating the row already being materialized by a prior
   * enqueueWorkerMessage call). Defaults to always-null (never yet
   * materialized). Runs out of entries -> repeats the last one.
   */
  intentOutboxIdSequence?: Array<string | null>;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let intentInsertCallCount = 0;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO worker_message_intents/.test(sql)) {
      const sequence = opts.intentOutboxIdSequence ?? [null];
      const outboxId = sequence[Math.min(intentInsertCallCount, sequence.length - 1)];
      intentInsertCallCount += 1;
      return { rows: [{ id: 'intent-1', outbox_id: outboxId }] };
    }
    if (/FROM worker_onboarding_state/.test(sql)) {
      return { rows: opts.gateRow === undefined || opts.gateRow === null ? [] : [opts.gateRow] };
    }
    if (/FROM whatsapp_runtime_controls/.test(sql)) {
      return {
        rows: [{
          control_key: 'deferred_delivery_enabled',
          enabled: opts.deferredDeliveryEnabled ?? false,
          phone_hashes: [],
          global_enabled: false,
        }],
      };
    }
    if (/UPDATE worker_message_intents/.test(sql) && /SET status/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT status FROM worker_message_intents/.test(sql)) {
      return { rows: [{ status: opts.intentStatusForOutboxCheck ?? 'eligible' }] };
    }
    if (/INSERT INTO whatsapp_outbox/.test(sql)) {
      return { rows: [{ id: 'outbox-1' }] };
    }
    if (/UPDATE worker_message_intents SET outbox_id/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, client: { query } as any, calls };
}

const readyGateRow = {
  user_id: WORKER_ID,
  lifecycle: 'ready',
  run_id: null,
  workflow_version: null,
  current_step_key: null,
  status: null,
  preferred_language: 'es',
  lock_version: null,
};

describe('enqueueWorkerMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _clearCategoryRenderersForTests();
  });

  it('defers job_alert delivery while the worker is still onboarding (no gate row yet)', async () => {
    const { client, calls } = scriptedClient({ gateRow: null });

    const { intentId, decision } = await enqueueWorkerMessage(client, baseInput());

    expect(intentId).toBe('intent-1');
    expect(decision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
    const statusUpdate = calls.find((c) =>
      /UPDATE worker_message_intents/.test(c.sql) && /SET status/.test(c.sql));
    expect(statusUpdate?.params).toEqual(['deferred', 'worker_onboarding', 'intent-1']);
  });

  it('still defers for an onboarding worker regardless of any focused conversation (delivery-policy has no focus input)', async () => {
    // evaluateDelivery's signature takes no "focused conversation" field, and
    // the gateway never derives one — lifecycle alone drives this decision.
    const { client, calls } = scriptedClient({
      gateRow: { ...readyGateRow, lifecycle: 'onboarding' },
    });

    const { decision } = await enqueueWorkerMessage(client, baseInput());

    expect(decision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
  });

  it('allows and renders exactly once when the worker is ready and deferred delivery is enabled', async () => {
    const { client, calls } = scriptedClient({
      gateRow: readyGateRow,
      deferredDeliveryEnabled: true,
    });
    const rendered: RenderedOutboxMessage = {
      whatsappNumber: '+15125551234',
      body: 'A new job is available',
      contentTemplate: null,
      contentVariables: null,
    };
    const renderer = jest.fn(async () => rendered);
    registerCategoryRenderer('job_alert', renderer);

    const { intentId, decision } = await enqueueWorkerMessage(client, baseInput());

    expect(intentId).toBe('intent-1');
    expect(decision).toEqual({ action: 'allow', reason: 'worker_ready' });
    expect(renderer).toHaveBeenCalledTimes(1);
    const outboxInserts = calls.filter((c) => /INSERT INTO whatsapp_outbox/.test(c.sql));
    expect(outboxInserts).toHaveLength(1);
    // source_id is the last positional param per the insertAuthorizedIntentOutbox contract.
    expect(outboxInserts[0].params[outboxInserts[0].params.length - 1]).toBe('intent-1');
  });

  it('leaves the intent eligible with renderer_unavailable when no renderer is registered', async () => {
    const { client, calls } = scriptedClient({
      gateRow: readyGateRow,
      deferredDeliveryEnabled: true,
    });

    const { decision } = await enqueueWorkerMessage(client, baseInput());

    expect(decision).toEqual({ action: 'allow', reason: 'worker_ready' });
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
    const renderUnavailableUpdate = calls.find((c) =>
      Array.isArray(c.params) && c.params.includes('renderer_unavailable'));
    expect(renderUnavailableUpdate).toBeDefined();
  });

  it('dedupe pair (1/2): two calls with the same dedupeKey on the deferred path produce one intent row and zero outbox rows', async () => {
    const { client, calls } = scriptedClient({ gateRow: null });
    const input = baseInput();

    const first = await enqueueWorkerMessage(client, input);
    const second = await enqueueWorkerMessage(client, input);

    expect(first.intentId).toBe('intent-1');
    expect(second.intentId).toBe('intent-1');
    const intentInserts = calls.filter((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    expect(intentInserts).toHaveLength(2); // idempotent ON CONFLICT no-op, same id both times
    const outboxInserts = calls.filter((c) => /INSERT INTO whatsapp_outbox/.test(c.sql));
    expect(outboxInserts).toHaveLength(0);
  });

  it('dedupe pair (2/2): two calls with the same dedupeKey on the allow path produce at most one outbox row', async () => {
    // Simulates the row already being materialized by the first call: the
    // second intent-insert RETURNING reports a non-null outbox_id, so the
    // gateway must skip the renderer and the outbox insert entirely rather
    // than writing a second whatsapp_outbox row for the same intent.
    const { client, calls } = scriptedClient({
      gateRow: readyGateRow,
      deferredDeliveryEnabled: true,
      intentOutboxIdSequence: [null, 'outbox-1'],
    });
    const rendered: RenderedOutboxMessage = {
      whatsappNumber: '+15125551234',
      body: 'A new job is available',
      contentTemplate: null,
      contentVariables: null,
    };
    const renderer = jest.fn(async () => rendered);
    registerCategoryRenderer('job_alert', renderer);
    const input = baseInput();

    const first = await enqueueWorkerMessage(client, input);
    const second = await enqueueWorkerMessage(client, input);

    expect(first.intentId).toBe('intent-1');
    expect(second.intentId).toBe('intent-1');
    expect(first.decision).toEqual({ action: 'allow', reason: 'worker_ready' });
    expect(second.decision).toEqual({ action: 'allow', reason: 'worker_ready' });
    expect(renderer).toHaveBeenCalledTimes(1);
    const outboxInserts = calls.filter((c) => /INSERT INTO whatsapp_outbox/.test(c.sql));
    expect(outboxInserts).toHaveLength(1);
  });

  it('rejects onboarding-category intents from a non-onboarding-v2 owner and writes no outbox row', async () => {
    const { client, calls } = scriptedClient({ gateRow: readyGateRow, deferredDeliveryEnabled: true });

    const { decision } = await enqueueWorkerMessage(
      client,
      baseInput({ category: 'onboarding', ownerService: 'job-alert' }),
    );

    expect(decision).toEqual({ action: 'reject', reason: 'invalid_owner' });
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
  });

  it('never calls fetch (no Twilio side effects from the gateway)', async () => {
    const { client } = scriptedClient({ gateRow: readyGateRow, deferredDeliveryEnabled: true });
    registerCategoryRenderer('job_alert', async () => ({
      whatsappNumber: '+15125551234',
      body: 'hi',
      contentTemplate: null,
      contentVariables: null,
    }));

    await enqueueWorkerMessage(client, baseInput());

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
