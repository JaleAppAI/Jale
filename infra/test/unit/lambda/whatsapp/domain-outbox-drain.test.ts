const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease }));
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setInternalUserRlsContext: jest.fn(async (client: { query: (...args: unknown[]) => unknown }, workerId: string) => {
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
  }),
}));

const mockReleaseWorkerReady = jest.fn();
jest.mock('../../../../lambda/whatsapp/worker-ready-release', () => ({
  releaseWorkerReady: mockReleaseWorkerReady,
}));

import {
  runDrain,
  MAX_DOMAIN_EVENT_ATTEMPTS,
  DOMAIN_EVENT_BATCH_LIMIT,
} from '../../../../lambda/whatsapp/domain-outbox-drain';

const fakePool = { connect: mockConnect } as any;

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const NOW = new Date('2026-07-22T12:00:00.000Z');

interface FakeDomainEventRow {
  id: string;
  event_type: 'worker.ready' | 'assessment.requested';
  aggregate_id: string;
  event_key: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  lease_token: string;
  leased_until: Date;
  created_at: Date;
}

function makeEvent(overrides: Partial<FakeDomainEventRow> = {}): FakeDomainEventRow {
  return {
    id: 'row-1',
    event_type: 'worker.ready',
    aggregate_id: WORKER_ID,
    event_key: `worker.ready:${WORKER_ID}:1`,
    payload: {},
    status: 'processing',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    lease_token: '11111111-1111-4111-8111-111111111111',
    leased_until: new Date(NOW.getTime() + 15 * 60 * 1000),
    created_at: NOW,
    ...overrides,
  };
}

/**
 * Scripts the fake pg client used by every test: dispatches by SQL
 * substring, matching the `lease_worker_domain_events(p_event_type, ...)`
 * two-call shape (worker.ready first, then assessment.requested with the
 * remaining budget) and the per-event BEGIN/RLS/dispatch/COMMIT contract.
 */
function scriptClient(opts: {
  readyRows?: FakeDomainEventRow[];
  assessmentRows?: FakeDomainEventRow[];
  updateRowCount?: number;
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const readyRows = opts.readyRows ?? [];
  const assessmentRows = opts.assessmentRows ?? [];
  const updateRowCount = opts.updateRowCount ?? 1;

  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (/lease_worker_domain_events/.test(sql)) {
      const [eventType] = params as [string, number];
      if (eventType === 'worker.ready') return { rows: readyRows };
      if (eventType === 'assessment.requested') return { rows: assessmentRows };
      return { rows: [] };
    }

    if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) {
      return { rows: [] };
    }

    if (/set_config\('app\.current_internal_user_id'/.test(sql)) {
      return { rows: [] };
    }

    if (/UPDATE worker_domain_outbox/.test(sql)) {
      return { rows: [], rowCount: updateRowCount };
    }

    if (/INSERT INTO worker_trust_assessments/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }

    return { rows: [] };
  });

  return calls;
}

describe('domain-outbox-drain', () => {
  let logSpy: jest.SpyInstance;
  let logLines: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    logLines = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      logLines.push(String(line));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('claims at most DOMAIN_EVENT_BATCH_LIMIT (25) events per invocation, in code', async () => {
    expect(DOMAIN_EVENT_BATCH_LIMIT).toBe(25);
    const readyRows = Array.from({ length: 20 }, (_, i) =>
      makeEvent({ id: `r${i}`, event_key: `worker.ready:${WORKER_ID}:${i}` }));
    const assessmentRows = Array.from({ length: 10 }, (_, i) =>
      makeEvent({
        id: `a${i}`,
        event_type: 'assessment.requested',
        event_key: `assessment.requested:${WORKER_ID}:${i}`,
        payload: {},
      }));
    const calls = scriptClient({ readyRows, assessmentRows: assessmentRows.slice(0, 5) });
    mockReleaseWorkerReady.mockResolvedValue({ released: 0, expired: 0, superseded: 0, failed: 0 });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    // 20 worker.ready + 5 remaining-budget assessment.requested = 25, never 30.
    expect(result.claimed).toBe(25);
    expect(result.claimed).toBeLessThanOrEqual(25);

    const leaseCalls = calls.filter((c) => /lease_worker_domain_events/.test(c.sql));
    expect(leaseCalls).toHaveLength(2);
    expect(leaseCalls[0].params).toEqual(['worker.ready', 25]);
    expect(leaseCalls[1].params).toEqual(['assessment.requested', 5]);
  });

  it('skips the second lease call entirely when the first call exhausts the batch budget', async () => {
    const readyRows = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `r${i}`, event_key: `worker.ready:${WORKER_ID}:${i}` }));
    const calls = scriptClient({ readyRows });
    mockReleaseWorkerReady.mockResolvedValue({ released: 0, expired: 0, superseded: 0, failed: 0 });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.claimed).toBe(25);
    const leaseCalls = calls.filter((c) => /lease_worker_domain_events/.test(c.sql));
    // Exactly one lease call — passing p_limit=0 to lease_worker_domain_events
    // would throw (migration 042 rejects p_limit < 1), so the drain must not
    // make that second call at all once the budget is exhausted.
    expect(leaseCalls).toHaveLength(1);
  });

  it('a successful worker.ready event sets RLS context to aggregate_id before releaseWorkerReady, calls it exactly once, and marks the event completed in the same transaction', async () => {
    const event = makeEvent();
    const calls = scriptClient({ readyRows: [event] });
    mockReleaseWorkerReady.mockResolvedValue({ released: 1, expired: 0, superseded: 0, failed: 0 });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockReleaseWorkerReady).toHaveBeenCalledTimes(1);
    expect(mockReleaseWorkerReady).toHaveBeenCalledWith(
      expect.anything(),
      event.event_key,
      expect.objectContaining({}),
    );

    const sqlSequence = calls.map((c) => c.sql);
    const beginIdx = sqlSequence.findIndex((s) => /^BEGIN$/.test(s));
    const rlsIdx = sqlSequence.findIndex((s) => /set_config\('app\.current_internal_user_id'/.test(s));
    const completeIdx = sqlSequence.findIndex((s) =>
      /UPDATE worker_domain_outbox/.test(s) && /status\s*=\s*'completed'/.test(s));
    const commitIdx = sqlSequence.findIndex((s) => /^COMMIT$/.test(s));

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(rlsIdx).toBeGreaterThan(beginIdx);
    expect(completeIdx).toBeGreaterThan(rlsIdx);
    expect(commitIdx).toBeGreaterThan(completeIdx);
    expect(calls[completeIdx].sql).toMatch(/status\s*=\s*'processing'/);
    expect(calls[completeIdx].sql).toMatch(/lease_token\s*=\s*\$2/);
    expect(calls[completeIdx].params).toEqual([event.event_key, event.lease_token]);

    // RLS context must be set to the leased event's aggregate_id (the workerId).
    const rlsParams = calls[rlsIdx].params;
    expect(rlsParams).toEqual([WORKER_ID]);
  });

  it('a thrown dispatch marks the event failed with attempts+1, a next_attempt_at, and emits WhatsAppReleaseFailure', async () => {
    const event = makeEvent({ attempts: 1 });
    const calls = scriptClient({ readyRows: [event] });
    mockReleaseWorkerReady.mockRejectedValue(new Error('boom'));

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);

    const rollbackIdx = calls.findIndex((c) => /^ROLLBACK$/.test(c.sql));
    expect(rollbackIdx).toBeGreaterThanOrEqual(0);

    const failureUpdate = calls.find((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'pending'/.test(c.sql));
    expect(failureUpdate).toBeDefined();
    // attempts + 1 (was 1, now 2) and a next_attempt_at param present.
    expect(failureUpdate!.params).toEqual(
      expect.arrayContaining([event.event_key, 2]),
    );
    expect(failureUpdate!.sql).toMatch(/next_attempt_at/);
    expect(failureUpdate!.sql).toMatch(/status\s*=\s*'processing'/);
    expect(failureUpdate!.sql).toMatch(/lease_token\s*=\s*\$5/);
    expect(failureUpdate!.params).toEqual(expect.arrayContaining([event.lease_token]));

    const metricLines = logLines.filter((l) => l.includes('WhatsAppReleaseFailure'));
    expect(metricLines.length).toBeGreaterThanOrEqual(1);
  });

  it('the fifth failure emits WhatsAppDomainEventStuck and sets status=failed (terminal)', async () => {
    const event = makeEvent({ attempts: MAX_DOMAIN_EVENT_ATTEMPTS - 1 });
    const calls = scriptClient({ readyRows: [event] });
    mockReleaseWorkerReady.mockRejectedValue(new Error('boom again'));

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.failed).toBe(1);

    const failureUpdate = calls.find((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'failed'/.test(c.sql));
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate!.params).toEqual(
      expect.arrayContaining([event.event_key, MAX_DOMAIN_EVENT_ATTEMPTS]),
    );
    expect(failureUpdate!.sql).toMatch(/status\s*=\s*'processing'/);
    expect(failureUpdate!.sql).toMatch(/lease_token\s*=\s*\$4/);
    expect(failureUpdate!.params).toEqual(expect.arrayContaining([event.lease_token]));

    const stuckLines = logLines.filter((l) => l.includes('WhatsAppDomainEventStuck'));
    expect(stuckLines.length).toBeGreaterThanOrEqual(1);
  });

  it('sets RLS context before the terminal UPDATE on the assessment.requested completion path too', async () => {
    const event = makeEvent({
      id: 'a-1',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:1`,
      payload: { profession_key: 'painter', answers: [] },
    });
    const calls = scriptClient({ readyRows: [], assessmentRows: [event] });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.completed).toBe(1);
    expect(mockReleaseWorkerReady).not.toHaveBeenCalled();

    const sqlSequence = calls.map((c) => c.sql);
    const rlsIdx = sqlSequence.findIndex((s) => /set_config\('app\.current_internal_user_id'/.test(s));
    const completeIdx = sqlSequence.findIndex((s) =>
      /UPDATE worker_domain_outbox/.test(s) && /status\s*=\s*'completed'/.test(s));
    expect(rlsIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(rlsIdx);
    expect(calls[completeIdx].sql).toMatch(/status\s*=\s*'processing'/);
    expect(calls[completeIdx].sql).toMatch(/lease_token\s*=\s*\$2/);
    expect(calls[completeIdx].params).toEqual([event.event_key, event.lease_token]);
  });

  it('rejects a stale owner when its lease token no longer owns the event', async () => {
    const event = makeEvent();
    const calls = scriptClient({ readyRows: [event], updateRowCount: 0 });
    mockReleaseWorkerReady.mockResolvedValue({ released: 1, expired: 0, superseded: 0, failed: 0 });

    await expect(runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW }))
      .rejects.toThrow('domain_event_lease_lost');

    const updates = calls.filter((c) => /UPDATE worker_domain_outbox/.test(c.sql));
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.every((c) => c.params.includes(event.lease_token))).toBe(true);
    expect(calls.some((c) => /^ROLLBACK$/.test(c.sql))).toBe(true);
  });

  it('assessment.requested with no profession_key is acknowledged (marked completed) without inserting a trust-assessment row', async () => {
    const event = makeEvent({
      id: 'a-2',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:2`,
      payload: {},
    });
    const calls = scriptClient({ readyRows: [], assessmentRows: [event] });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(result.completed).toBe(1);
    const insertCalls = calls.filter((c) => /INSERT INTO worker_trust_assessments/.test(c.sql));
    expect(insertCalls).toHaveLength(0);
  });

  it('the drain never calls fetch', async () => {
    const event = makeEvent();
    scriptClient({ readyRows: [event] });
    mockReleaseWorkerReady.mockResolvedValue({ released: 1, expired: 0, superseded: 0, failed: 0 });
    const fetchSpy = jest.fn();
    (global as unknown as { fetch?: unknown }).fetch = fetchSpy;

    await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no emitted log line contains a phone-shaped digit run or the substring "otp"', async () => {
    const failEvent = makeEvent({ attempts: 4 });
    scriptClient({ readyRows: [failEvent] });
    mockReleaseWorkerReady.mockRejectedValue(new Error('OTP challenge for +15551234567 expired'));

    await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW });

    for (const line of logLines) {
      expect(line.toLowerCase()).not.toContain('otp');
      expect(line).not.toMatch(/\d{7,}/);
    }
  });

  it('handler() — the real EventBridge entrypoint — takes no meaningful argument and never mistakes a ScheduledEvent for deps', async () => {
    // EventBridge invokes exported Lambda handlers as handler(event, context).
    // If `handler` read its first parameter as `deps`, the ScheduledEvent
    // object would be truthy and silently become `deps`, leaving
    // `deps.renderer` undefined and making every worker.ready dispatch throw
    // a TypeError. Import fresh so `setDomainOutboxDrainDeps` starts from the
    // module's real default.
    jest.resetModules();
    const mod = await import('../../../../lambda/whatsapp/domain-outbox-drain');
    scriptClient({ readyRows: [] });

    const fakeScheduledEvent = { 'detail-type': 'Scheduled Event', detail: {} };
    const result = await (mod.handler as unknown as (e: unknown) => Promise<unknown>)(fakeScheduledEvent);

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });

  it('setDomainOutboxDrainDeps swaps the renderer used by the real handler() entrypoint (the C10 wiring seam)', async () => {
    jest.resetModules();
    const mod = await import('../../../../lambda/whatsapp/domain-outbox-drain');
    const event = makeEvent();
    scriptClient({ readyRows: [event] });
    mockReleaseWorkerReady.mockResolvedValue({ released: 1, expired: 0, superseded: 0, failed: 0 });
    const injectedRenderer = { render: jest.fn() };

    mod.setDomainOutboxDrainDeps({ renderer: injectedRenderer, now: () => NOW });
    const result = await mod.handler();

    expect(result.completed).toBe(1);
    expect(mockReleaseWorkerReady).toHaveBeenCalledWith(
      expect.anything(),
      event.event_key,
      expect.objectContaining({ renderer: injectedRenderer }),
    );
  });
});
