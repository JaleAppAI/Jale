import type { PoolClient } from 'pg';
import { retriggerDeferredReadyWorkers } from '../../../../../lambda/whatsapp/lib/delivery-retrigger-sweep';

/**
 * A fake PoolClient that dispatches by SQL substring, mirroring the
 * scriptedClient() convention in worker-ready-release.test.ts. It models
 * exactly the two statements the sweep issues:
 *   1. the eligible-workers SELECT (ready lifecycle + deferred business
 *      intent + no worker.ready emitted by this sweep generation), and
 *   2. the per-worker worker_domain_outbox INSERT ... ON CONFLICT DO NOTHING.
 *
 * `eligibleWorkerIds` is consumed like a real backing table would be: once a
 * worker.ready event has been "inserted" for a worker, that worker is
 * removed from future SELECT results — mirroring the sweep's own
 * `NOT EXISTS (... current-generation worker.ready ...)` guard against the
 * real schema.
 */
function scriptedClient(opts: {
  eligibleWorkerIds: string[];
  /** worker ids that already have this sweep generation's worker.ready row. */
  alreadyCurrentSweepWorkerIds?: string[];
  /** event_keys that already exist (INSERT should be a no-op ON CONFLICT). */
  existingEventKeys?: Set<string>;
}) {
  const remaining = opts.eligibleWorkerIds.filter(
    (id) => !(opts.alreadyCurrentSweepWorkerIds ?? []).includes(id),
  );
  const currentSweepIds = new Set(opts.alreadyCurrentSweepWorkerIds ?? []);
  const existingEventKeys = opts.existingEventKeys ?? new Set<string>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const insertedEventKeys: string[] = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (/SELECT DISTINCT s\.user_id/.test(sql)) {
      const limit = params[1] as number;
      const rows = remaining
        .filter((id) => !currentSweepIds.has(id))
        .slice(0, limit)
        .map((id) => ({ user_id: id }));
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO worker_domain_outbox/.test(sql)) {
      const [workerId, eventKey] = params as [string, string];
      if (existingEventKeys.has(eventKey)) {
        return { rows: [], rowCount: 0 };
      }
      existingEventKeys.add(eventKey);
      insertedEventKeys.push(eventKey);
      currentSweepIds.add(workerId); // subsequent SELECTs no longer see this worker
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`scriptedClient: unhandled SQL: ${sql}`);
  });

  return { query, calls, insertedEventKeys } as unknown as PoolClient & {
    calls: Array<{ sql: string; params: unknown[] }>;
    insertedEventKeys: string[];
  };
}

describe('retriggerDeferredReadyWorkers', () => {
  it('enqueues a fresh worker.ready event for each eligible ready+deferred worker', async () => {
    const client = scriptedClient({ eligibleWorkerIds: ['worker-1', 'worker-2'] });

    const result = await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    expect(result).toEqual({ workersSwept: 2, eventsEnqueued: 2 });
    expect(client.insertedEventKeys).toEqual([
      'worker.ready:sweep:worker-1:run-1',
      'worker.ready:sweep:worker-2:run-1',
    ]);
  });

  it('issues only the eligible-workers SELECT and the worker_domain_outbox INSERT (no writes to worker_message_intents)', async () => {
    const client = scriptedClient({ eligibleWorkerIds: ['worker-1'] });

    await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    for (const call of client.calls) {
      expect(call.sql).not.toMatch(/UPDATE worker_message_intents/);
      expect(call.sql).not.toMatch(/DELETE/i);
    }
  });

  it('the eligible-workers SELECT excludes only this sweep generation, never unrelated pending or processing events', async () => {
    const client = scriptedClient({ eligibleWorkerIds: ['worker-1'] });

    await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    const selectCall = client.calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.sql));
    expect(selectCall).toBeDefined();
    expect(selectCall!.sql).toMatch(/lifecycle = 'ready'/);
    expect(selectCall!.sql).toMatch(/i\.status = 'deferred'/);
    expect(selectCall!.sql).toMatch(/i\.outbox_id IS NULL/);
    expect(selectCall!.sql).toMatch(/i\.category = ANY/);
    expect(selectCall!.params[0]).toEqual(['account', 'job_alert', 'employer_chat']);
    expect(selectCall!.sql).toMatch(/NOT EXISTS/);
    expect(selectCall!.sql).toMatch(/o\.event_key = 'worker\.ready:sweep:' \|\| s\.user_id::text \|\| ':' \|\| \$3/);
    expect(selectCall!.params[2]).toBe('run-1');
  });

  it('never includes onboarding or security categories in the eligibility filter', async () => {
    const client = scriptedClient({ eligibleWorkerIds: [] });

    await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    const selectCall = client.calls.find((c) => /SELECT DISTINCT s\.user_id/.test(c.sql));
    const categories = selectCall!.params[0] as string[];
    expect(categories).not.toContain('onboarding');
    expect(categories).not.toContain('security');
  });

  it('skips workers that already have a worker.ready event from the same sweep generation', async () => {
    const client = scriptedClient({
      eligibleWorkerIds: ['worker-1', 'worker-2'],
      alreadyCurrentSweepWorkerIds: ['worker-1'],
    });

    const result = await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    expect(result).toEqual({ workersSwept: 1, eventsEnqueued: 1 });
    expect(client.insertedEventKeys).toEqual(['worker.ready:sweep:worker-2:run-1']);
  });

  it('bounds each round-trip to `limit` and loops in chunks until no eligible workers remain', async () => {
    const eligibleWorkerIds = Array.from({ length: 5 }, (_, i) => `worker-${i + 1}`);
    const client = scriptedClient({ eligibleWorkerIds });

    const result = await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1', limit: 2 });

    expect(result).toEqual({ workersSwept: 5, eventsEnqueued: 5 });
    // 5 workers at limit=2 per page -> 3 SELECT round-trips (2, 2, 1), each
    // never requesting more than `limit` rows.
    const selectCalls = client.calls.filter((c) => /SELECT DISTINCT s\.user_id/.test(c.sql));
    expect(selectCalls).toHaveLength(3);
    for (const call of selectCalls) {
      expect(call.params[1]).toBe(2);
    }
  });

  it('generates a fresh event_key per sweep generation (distinct sweepRunId never collides)', async () => {
    const client1 = scriptedClient({ eligibleWorkerIds: ['worker-1'] });
    await retriggerDeferredReadyWorkers(client1, { sweepRunId: 'generation-a' });

    const client2 = scriptedClient({ eligibleWorkerIds: ['worker-1'] });
    await retriggerDeferredReadyWorkers(client2, { sweepRunId: 'generation-b' });

    expect(client1.insertedEventKeys).toEqual(['worker.ready:sweep:worker-1:generation-a']);
    expect(client2.insertedEventKeys).toEqual(['worker.ready:sweep:worker-1:generation-b']);
  });

  it('defaults to a fresh random sweepRunId when none is supplied, so two calls never collide', async () => {
    const client1 = scriptedClient({ eligibleWorkerIds: ['worker-1'] });
    await retriggerDeferredReadyWorkers(client1);

    const client2 = scriptedClient({ eligibleWorkerIds: ['worker-1'] });
    await retriggerDeferredReadyWorkers(client2);

    expect(client1.insertedEventKeys).toHaveLength(1);
    expect(client2.insertedEventKeys).toHaveLength(1);
    expect(client1.insertedEventKeys[0]).not.toEqual(client2.insertedEventKeys[0]);
  });

  it('is idempotent: an ON CONFLICT no-op INSERT (event_key already exists) still counts the worker as swept but not as a fresh event', async () => {
    const existingKey = 'worker.ready:sweep:worker-1:run-1';
    const client = scriptedClient({
      eligibleWorkerIds: ['worker-1'],
      existingEventKeys: new Set([existingKey]),
    });

    const result = await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    expect(result).toEqual({ workersSwept: 1, eventsEnqueued: 0 });
  });

  it('rejects a non-positive or non-integer limit before issuing any query', async () => {
    const client = scriptedClient({ eligibleWorkerIds: [] });

    await expect(retriggerDeferredReadyWorkers(client, { limit: 0 })).rejects.toThrow(
      'retrigger_sweep_invalid_limit',
    );
    await expect(retriggerDeferredReadyWorkers(client, { limit: -5 })).rejects.toThrow(
      'retrigger_sweep_invalid_limit',
    );
    await expect(retriggerDeferredReadyWorkers(client, { limit: 1.5 })).rejects.toThrow(
      'retrigger_sweep_invalid_limit',
    );
    expect(client.calls).toHaveLength(0);
  });

  it('returns zero counts and issues exactly one SELECT when there is nothing to sweep', async () => {
    const client = scriptedClient({ eligibleWorkerIds: [] });

    const result = await retriggerDeferredReadyWorkers(client, { sweepRunId: 'run-1' });

    expect(result).toEqual({ workersSwept: 0, eventsEnqueued: 0 });
    expect(client.calls).toHaveLength(1);
  });
});
