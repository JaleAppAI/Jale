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

const mockPublishWorkerIntentWake = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/outbox-wake', () => ({
  publishWorkerIntentWake: () => mockPublishWorkerIntentWake(),
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
  pendingAssessmentRow?: { id: string } | null;
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const readyRows = opts.readyRows ?? [];
  const assessmentRows = opts.assessmentRows ?? [];
  const updateRowCount = opts.updateRowCount ?? 1;
  const pendingAssessmentRow = 'pendingAssessmentRow' in opts ? opts.pendingAssessmentRow : { id: 'wta-1' };

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

    if (/SELECT id FROM worker_trust_assessments/.test(sql)) {
      return { rows: pendingAssessmentRow ? [pendingAssessmentRow] : [] };
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
    // R1-X: several tests below inject `dispatchAssessment` but not
    // `dispatchExtraction`, so they now reach `defaultDispatchExtraction` on
    // the happy path. Jest shares `process.env` across test FILES in a worker,
    // so a sibling suite that sets TRUST_EXTRACTION_QUEUE_URL would make that
    // default construct a real SQSClient and issue a real SendMessage — which
    // the fail-open catch would then swallow, leaving a green suite that
    // touched AWS. Unsetting it here makes the default throw before the SDK
    // import, for these tests and for any added later.
    delete process.env.TRUST_EXTRACTION_QUEUE_URL;
    // Identical hazard on the scorer lane: trust-scorer.test.ts sets
    // TRUST_ASSESSMENT_QUEUE_URL and never clears it, and the tests below
    // reach defaultDispatchAssessment.
    delete process.env.TRUST_ASSESSMENT_QUEUE_URL;
    mockPublishWorkerIntentWake.mockResolvedValue({ sent: 1, failed: 0 });
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
    expect(result.readyCompleted).toBe(1);
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

  it('sets RLS context before the resolve SELECT and the terminal UPDATE on the assessment.requested completion path too', async () => {
    const event = makeEvent({
      id: 'a-1',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:1`,
      payload: { professionKey: 'painter' },
    });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-1' } });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });

    expect(result.completed).toBe(1);
    expect(mockReleaseWorkerReady).not.toHaveBeenCalled();
    expect(dispatchAssessment).toHaveBeenCalledWith({
      assessmentId: 'wta-1',
      userId: WORKER_ID,
      professionKey: 'painter',
    });

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

  it('assessment.requested with a missing professionKey fails closed: no dispatch, event NOT completed, markFailure invoked', async () => {
    const event = makeEvent({
      id: 'a-2',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:2`,
      payload: {},
    });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    const calls = scriptClient({ readyRows: [], assessmentRows: [event] });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(dispatchAssessment).not.toHaveBeenCalled();
    const completeCalls = calls.filter((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'completed'/.test(c.sql));
    expect(completeCalls).toHaveLength(0);
    const pendingRetryUpdate = calls.find((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'pending'/.test(c.sql));
    expect(pendingRetryUpdate).toBeDefined();
  });

  it('assessment.requested with no pending worker_trust_assessments row fails closed: no dispatch, markFailure invoked', async () => {
    const event = makeEvent({
      id: 'a-3',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:3`,
      payload: { professionKey: 'painter' },
    });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: null });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(dispatchAssessment).not.toHaveBeenCalled();
    const pendingRetryUpdate = calls.find((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'pending'/.test(c.sql));
    expect(pendingRetryUpdate).toBeDefined();
  });

  it('sends to SQS BEFORE marking the event completed: dispatch throws → completion UPDATE never runs, markFailure invoked', async () => {
    const event = makeEvent({
      id: 'a-4',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:4`,
      payload: { professionKey: 'painter' },
    });
    const dispatchAssessment = jest.fn().mockRejectedValue(new Error('trust_assessment_queue_url_not_configured'));
    const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-4' } });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(dispatchAssessment).toHaveBeenCalledTimes(1);
    const completeCalls = calls.filter((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'completed'/.test(c.sql));
    expect(completeCalls).toHaveLength(0);
    expect(calls.some((c) => /^ROLLBACK$/.test(c.sql))).toBe(true);
    const pendingRetryUpdate = calls.find((c) =>
      /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'pending'/.test(c.sql));
    expect(pendingRetryUpdate).toBeDefined();

    const metricLines = logLines.filter((l) => l.includes('WhatsAppAssessmentDispatchFailure'));
    expect(metricLines.length).toBeGreaterThanOrEqual(1);
  });

  it('a rejected dispatchAssessment (SQS failure) is retried via markFailure and counted failed by runDrain', async () => {
    const event = makeEvent({
      id: 'a-5',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:5`,
      payload: { professionKey: 'electrician' },
      attempts: 1,
    });
    const dispatchAssessment = jest.fn().mockRejectedValue(new Error('sqs unavailable'));
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-5' } });

    const result = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });

    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
  });

  it('duplicate handling: dispatchAssessment is called again on a re-leased assessment event with the same payload, harmlessly, and a completed event is not re-leased', async () => {
    const event = makeEvent({
      id: 'a-6',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:6`,
      payload: { professionKey: 'plumber' },
    });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);

    // First pass: event is leased and processed successfully.
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-6' } });
    const first = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });
    expect(first.completed).toBe(1);
    expect(dispatchAssessment).toHaveBeenCalledTimes(1);

    // Simulate a crash-before-commit re-lease: the SAME event is leased again
    // (e.g. its lease expired before the completion UPDATE landed). Dispatch
    // fires again — harmless because TrustScorer idempotently claims the row.
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-6' } });
    const second = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });
    expect(second.completed).toBe(1);
    expect(dispatchAssessment).toHaveBeenCalledTimes(2);
    expect(dispatchAssessment).toHaveBeenNthCalledWith(2, {
      assessmentId: 'wta-6',
      userId: WORKER_ID,
      professionKey: 'plumber',
    });

    // A completed event is never re-leased by lease_worker_domain_events
    // (its `status` is no longer 'pending') — that guarantee lives in the
    // DB function itself (migration 042), not in this Lambda; this test
    // only asserts the drain does not itself re-process anything the fake
    // lease call does not hand it, i.e. an empty assessmentRows batch
    // yields zero additional dispatch calls.
    scriptClient({ readyRows: [], assessmentRows: [] });
    const third = await runDrain(fakePool, { renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment });
    expect(third.claimed).toBe(0);
    expect(dispatchAssessment).toHaveBeenCalledTimes(2);
  });

  it('defaultDispatchAssessment fails closed with trust_assessment_queue_url_not_configured when TRUST_ASSESSMENT_QUEUE_URL is unset, before touching the AWS SDK', async () => {
    const originalUrl = process.env.TRUST_ASSESSMENT_QUEUE_URL;
    delete process.env.TRUST_ASSESSMENT_QUEUE_URL;
    jest.resetModules();
    jest.doMock('@aws-sdk/client-sqs', () => {
      throw new Error('must not import @aws-sdk/client-sqs when the queue URL is unconfigured');
    });
    try {
      const mod = await import('../../../../lambda/whatsapp/domain-outbox-drain');
      await expect(
        mod.defaultDispatchAssessment({ assessmentId: 'x', userId: 'y', professionKey: 'z' }),
      ).rejects.toThrow('trust_assessment_queue_url_not_configured');
    } finally {
      jest.dontMock('@aws-sdk/client-sqs');
      if (originalUrl !== undefined) process.env.TRUST_ASSESSMENT_QUEUE_URL = originalUrl;
      jest.resetModules();
    }
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

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0, readyCompleted: 0 });
    expect(mockPublishWorkerIntentWake).not.toHaveBeenCalled();
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
    expect(mockPublishWorkerIntentWake).toHaveBeenCalledTimes(1);
  });
});

// ── R1-X: trust-extraction fan-out ──────────────────────────────────
// `assessment.requested` now fans out to TWO lanes: the TrustScorer queue
// (fail-CLOSED — a scoring dispatch failure retries the whole event) and the
// TrustExtractor queue (fail-OPEN — the extraction is a nice-to-have skill
// summary; losing it must never cost an onboarding or a trust score). These
// tests pin that asymmetry, which is the whole reason the second dispatch
// exists in its own inner try/catch.
describe('domain-outbox-drain — trust-extraction fan-out', () => {
  let logSpy: jest.SpyInstance;
  let logLines: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TRUST_EXTRACTION_QUEUE_URL;
    delete process.env.TRUST_ASSESSMENT_QUEUE_URL;
    mockPublishWorkerIntentWake.mockResolvedValue({ sent: 1, failed: 0 });
    logLines = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      logLines.push(String(line));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function assessmentEvent(overrides: Record<string, unknown> = {}) {
    return makeEvent({
      id: 'x-1',
      event_type: 'assessment.requested',
      event_key: `assessment.requested:${WORKER_ID}:x1`,
      payload: { professionKey: 'painter' },
      ...overrides,
    });
  }

  it('dispatches the SAME payload to the extraction lane after the scorer lane', async () => {
    const event = assessmentEvent();
    const order: string[] = [];
    const dispatchAssessment = jest.fn(async () => { order.push('assessment'); });
    const dispatchExtraction = jest.fn(async () => { order.push('extraction'); });
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x1' } });

    const result = await runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });

    expect(result.completed).toBe(1);
    expect(dispatchExtraction).toHaveBeenCalledWith({
      assessmentId: 'wta-x1',
      userId: WORKER_ID,
      professionKey: 'painter',
    });
    expect(order).toEqual(['assessment', 'extraction']);
  });

  // Awaiting the fan-out INSIDE the transaction only bounded rejections. An
  // SQS call that hangs instead of rejecting would run to the Lambda timeout
  // with the transaction still open — the event rolls back and is retried,
  // and the message that was already sent becomes a duplicate. Committing
  // first makes a hang cost nothing but the extraction.
  it('dispatches only AFTER the event is committed, so a slow queue cannot hold the transaction open', async () => {
    const event = assessmentEvent({ id: 'x-6' });
    const trace: string[] = [];
    const dispatchAssessment = jest.fn(async () => { trace.push('dispatchAssessment'); });
    const dispatchExtraction = jest.fn(async () => { trace.push('dispatchExtraction'); });

    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/lease_worker_domain_events/.test(sql)) {
        const [eventType] = params as [string, number];
        return { rows: eventType === 'assessment.requested' ? [event] : [] };
      }
      trace.push(sql.trim().split('\n')[0].slice(0, 40));
      if (/SELECT id FROM worker_trust_assessments/.test(sql)) return { rows: [{ id: 'wta-x6' }] };
      if (/UPDATE worker_domain_outbox/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const result = await runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });

    expect(result.completed).toBe(1);
    const commitIdx = trace.indexOf('COMMIT');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('dispatchAssessment')).toBeLessThan(commitIdx);
    expect(trace.indexOf('dispatchExtraction')).toBeGreaterThan(commitIdx);
  });

  it('a fan-out still in flight cannot roll back an already-committed event', async () => {
    const event = assessmentEvent({ id: 'x-7' });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    // A dispatch held open on a resolver we own — the shape of an SQS hang
    // rather than an SQS rejection. Holding the resolver (instead of a
    // never-settling promise plus a timing race) is what makes this
    // deterministic and leaves nothing dangling at test exit.
    let releaseDispatch!: () => void;
    const held = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const dispatchExtraction = jest.fn(() => held);
    const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x7' } });

    const pending = runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });
    // One macrotask turn is plenty: every mocked query resolves immediately,
    // so the drain runs to the fan-out and blocks there.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // WHILE the dispatch is still in flight, the event is already durably
    // completed and committed — a Lambda timeout here costs the extraction
    // and nothing else.
    expect(dispatchExtraction).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'completed'/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /^COMMIT$/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /^ROLLBACK$/.test(c.sql))).toBe(false);

    releaseDispatch();
    await expect(pending).resolves.toMatchObject({ completed: 1, failed: 0 });
  });

  it('is fail-OPEN: a thrown extraction dispatch still COMMITs the event, never rolls back and never marks a failure', async () => {
    const event = assessmentEvent({ id: 'x-2' });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    const dispatchExtraction = jest.fn().mockRejectedValue(new Error('sqs unavailable'));
    const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x2' } });

    const result = await runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(0);
    // The event still completes in its own transaction...
    expect(calls.some((c) => /UPDATE worker_domain_outbox/.test(c.sql) && /status\s*=\s*'completed'/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /^COMMIT$/.test(c.sql))).toBe(true);
    // ...and nothing resembling markFailure's retry/terminal UPDATE ran.
    expect(calls.some((c) => /^ROLLBACK$/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /UPDATE worker_domain_outbox/.test(c.sql) && /attempts\s*=\s*\$2/.test(c.sql))).toBe(false);
    expect(logLines.filter((l) => l.includes('WhatsAppAssessmentDispatchFailure'))).toHaveLength(0);
    expect(logLines.filter((l) => l.includes('WhatsAppExtractionDispatchFailure')).length).toBeGreaterThanOrEqual(1);
  });

  it('the extraction failure metric carries safe scalars only — no ids, no worker data', async () => {
    const event = assessmentEvent({ id: 'x-3' });
    const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
    const dispatchExtraction = jest.fn().mockRejectedValue(new Error(`queue down for ${WORKER_ID} at +15551239876`));
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x3' } });

    await runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });

    const line = logLines.find((l) => l.includes('WhatsAppExtractionDispatchFailure'))!;
    expect(JSON.parse(line)).toEqual({
      metric: 'WhatsAppExtractionDispatchFailure',
      event_type: 'assessment.requested',
    });
    expect(logLines.join('\n')).not.toContain(WORKER_ID);
    expect(logLines.join('\n')).not.toContain('15551239876');
  });

  it('an unset TRUST_EXTRACTION_QUEUE_URL is logged and the event still completes (fail-open), unlike the scorer queue', async () => {
    const original = process.env.TRUST_EXTRACTION_QUEUE_URL;
    delete process.env.TRUST_EXTRACTION_QUEUE_URL;
    try {
      const event = assessmentEvent({ id: 'x-4' });
      const dispatchAssessment = jest.fn().mockResolvedValue(undefined);
      const calls = scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x4' } });

      // No dispatchExtraction injected: this exercises defaultDispatchExtraction.
      const result = await runDrain(fakePool, {
        renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment,
      });

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(calls.some((c) => /^ROLLBACK$/.test(c.sql))).toBe(false);
      expect(logLines.filter((l) => l.includes('WhatsAppExtractionDispatchFailure')).length).toBeGreaterThanOrEqual(1);
    } finally {
      if (original !== undefined) process.env.TRUST_EXTRACTION_QUEUE_URL = original;
    }
  });

  it('defaultDispatchExtraction throws trust_extraction_queue_url_not_configured before touching the AWS SDK', async () => {
    const original = process.env.TRUST_EXTRACTION_QUEUE_URL;
    delete process.env.TRUST_EXTRACTION_QUEUE_URL;
    jest.resetModules();
    jest.doMock('@aws-sdk/client-sqs', () => {
      throw new Error('must not import @aws-sdk/client-sqs when the queue URL is unconfigured');
    });
    try {
      const mod = await import('../../../../lambda/whatsapp/domain-outbox-drain');
      await expect(
        mod.defaultDispatchExtraction({ assessmentId: 'x', userId: 'y', professionKey: 'z' }),
      ).rejects.toThrow('trust_extraction_queue_url_not_configured');
    } finally {
      jest.dontMock('@aws-sdk/client-sqs');
      if (original !== undefined) process.env.TRUST_EXTRACTION_QUEUE_URL = original;
      jest.resetModules();
    }
  });

  it('a failing SCORER dispatch still fails the event closed (the asymmetry is deliberate)', async () => {
    const event = assessmentEvent({ id: 'x-5' });
    const dispatchAssessment = jest.fn().mockRejectedValue(new Error('sqs unavailable'));
    const dispatchExtraction = jest.fn().mockResolvedValue(undefined);
    scriptClient({ readyRows: [], assessmentRows: [event], pendingAssessmentRow: { id: 'wta-x5' } });

    const result = await runDrain(fakePool, {
      renderer: { render: jest.fn() }, now: () => NOW, dispatchAssessment, dispatchExtraction,
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(1);
    expect(dispatchExtraction).not.toHaveBeenCalled();
  });
});
