// Mock AWS SDK clients + shared db module BEFORE importing the handler
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValueCommand' })),
}));

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockSetInternalUserRlsContext = jest.fn(
  (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, userId: string) =>
    client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [userId]),
);

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: jest.fn(),
  setInternalUserRlsContext: mockSetInternalUserRlsContext,
}));

// job-alert.ts is producer-only: it must never call Twilio (fetch). All
// sending happens in the separate drainJobAlertOutbox() scheduled job — see
// job-alert-drain.test.ts / outbox.test.ts for send-path coverage.
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/job-alert';

const JOB_ALERT_SID_ES = 'HXe94c8d14f1c84fb5dfc8909f9797a093';
const JOB_ALERT_SID_EN = 'HXd6fde4e795ec66d140b628536c3cff5b';

describe('Job Alert Sender Lambda (producer — queues only, never sends)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/twilio',
      DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    };

    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'outbox-claimed' }] });

    // Default Twilio secret with templates wired
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC12345',
        authToken: 'test-auth-token',
        messagingServiceSid: 'MGtest12345',
        templates: {
          job_alert_es: JOB_ALERT_SID_ES,
          job_alert_en: JOB_ALERT_SID_EN,
        },
      }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns early with no queue when jobId is missing', async () => {
    const result = await handler({});
    expect(result).toEqual({ queued: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns early when the job does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // job lookup

    const result = await handler({ jobId: 'nonexistent' });
    expect(result).toEqual({ queued: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('queues a durable, idempotent outbox row for a Spanish-language worker (never sends)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'job-uuid-1',
          title: 'Electricista',
          company: 'Martinez Construction',
          location: 'Downtown, Houston',
          pay: '$35/hr',
        }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'worker-uuid-1',
          whatsapp_number: '+15125551234',
          language: 'es',
          main_trade: 'electrician',
          legacy_ready: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-claimed' }] }); // queueJobAlert INSERT

    const result = await handler({ jobId: 'job-uuid-1' });

    expect(result).toEqual({ queued: 1, skipped: 0 });
    // Producer never talks to Twilio — that is the entire point of the fix.
    expect(mockFetch).not.toHaveBeenCalled();

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes("'job_alert'"));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall!;
    expect(sql).toContain('ON CONFLICT (idempotency_key)');
    expect(params).toEqual(expect.arrayContaining(['job-alert:job-uuid-1:worker-uuid-1']));

    const variablesJson = params[2];
    expect(JSON.parse(variablesJson)).toEqual({
      '1': 'Electricista',
      '2': 'Martinez Construction',
      '3': 'Downtown, Houston',
      '4': '$35/hr',
      '5': 'job-job-uuid-1',
    });
    expect(params[1]).toBe('job_alert_es');
  });

  it('queues the English template key for an English-language worker', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'j1', title: 'Electrician', company: 'ACME',
          location: 'Austin', pay: '$40/hr',
        }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'w1', whatsapp_number: '+15125550000',
          language: 'en', main_trade: 'electrician', legacy_ready: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-claimed' }] });

    const result = await handler({ jobId: 'j1' });
    expect(result).toEqual({ queued: 1, skipped: 0 });

    const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes("'job_alert'"));
    expect(insertCall![1][1]).toBe('job_alert_en');
  });

  it('queues one row per worker when sending to a mix of languages', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null, legacy_ready: true },
          { id: 'w2', whatsapp_number: '+1002', language: 'en', main_trade: null, legacy_ready: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] });

    const result = await handler({ jobId: 'j1' });
    expect(result).toEqual({ queued: 2, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('counts skipped (not an error) when the idempotent claim is a no-op', async () => {
    // e.g. already pending/sent, or failed at the attempt cap — queueJobAlert
    // returns undefined without throwing.
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          { id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null, legacy_ready: true },
          { id: 'w2', whatsapp_number: '+1002', language: 'en', main_trade: null, legacy_ready: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'outbox-1' }] })
      .mockResolvedValueOnce({ rows: [] }); // second worker: no-op claim

    const result = await handler({ jobId: 'j1' });

    expect(result).toEqual({ queued: 1, skipped: 1 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when job_alert template SIDs are missing from the Twilio secret', async () => {
    jest.resetModules();

    jest.doMock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
      GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValueCommand' })),
    }));
    jest.doMock('../../../../lambda/lib/db', () => ({
      getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
      setRlsContext: jest.fn(),
    }));

    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC1',
        authToken: 'tok',
        messagingServiceSid: 'MGtest',
        templates: {}, // templates present but empty
      }),
    });

    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null, legacy_ready: true }],
      });

    const { handler: freshHandler } = require('../../../../lambda/whatsapp/job-alert');
    await expect(freshHandler({ jobId: 'j1' })).rejects.toThrow('job_alert_es and job_alert_en');
  });

  it('returns zero when no workers match', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await handler({ jobId: 'j1' });

    expect(result).toEqual({ queued: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('selects v2-ready workers even when they have no legacy idle conversation', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await handler({ jobId: 'j1' });

    const candidateSelect = mockQuery.mock.calls.find(([sql]) =>
      /FROM users u/.test(sql) && /job_applications/.test(sql));
    expect(candidateSelect).toBeDefined();
    expect(candidateSelect![0]).toContain('LEFT JOIN whatsapp_conversations wc');
    expect(candidateSelect![0]).toContain('public.is_worker_ready_for_v2_delivery(u.id)');
    expect(candidateSelect![0]).toMatch(
      /\(wc\.conversation_state = 'idle'\s+OR public\.is_worker_ready_for_v2_delivery\(u\.id\)\)/,
    );
  });

  it('releases the DB client even on success', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await handler({ jobId: 'j1' });

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the DB client even when the job lookup fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));

    await expect(handler({ jobId: 'j1' })).rejects.toThrow('db down');

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('Job Alert Sender Lambda — v2 redirect', () => {
  const originalEnv = process.env;
  const V2_WORKER = 'worker-v2-uuid';
  const V2_PHONE = '+15125559999';

  // scriptedClient dispatches by SQL substring (not call order) so it stays
  // resilient to internal reordering — same convention as
  // worker-delivery-gateway.test.ts's scriptedClient.
  function scriptedClient(opts: {
    v2GlobalEnabled: boolean;
    gateRow?: Record<string, unknown> | null;
    workers?: Array<{ id: string; whatsapp_number: string; language: 'en' | 'es'; main_trade: null; legacy_ready?: boolean | null }>;
    failWorkerIds?: readonly string[];
  }) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM jobs WHERE id = \$1/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: 'job-1', title: 'Electricista', company: 'ACME',
            location: 'Austin', pay: '$40/hr',
          }],
        };
      }
      if (/JOIN whatsapp_conversations wc/.test(sql)) {
        const rows = opts.workers ?? [{
          id: V2_WORKER, whatsapp_number: V2_PHONE, language: 'es' as const, main_trade: null, legacy_ready: true,
        }];
        return { rowCount: rows.length, rows };
      }
      if (/FROM whatsapp_runtime_controls/.test(sql)) {
        return {
          rows: [{
            control_key: 'onboarding_v2_enabled',
            enabled: true,
            phone_hashes: [],
            global_enabled: opts.v2GlobalEnabled,
          }],
        };
      }
      if (/INSERT INTO worker_message_intents/.test(sql)) {
        const workerId = params[0] as string;
        if (opts.failWorkerIds?.includes(workerId)) throw new Error(`intent failure ${workerId}`);
        return { rows: [{ id: `intent-${workerId}`, outbox_id: null, status: 'deferred' }] };
      }
      if (/INSERT INTO whatsapp_outbox/.test(sql) && sql.includes("'job_alert'")) {
        return { rows: [{ id: 'outbox-legacy-1' }] };
      }
      if (/FROM worker_onboarding_state/.test(sql)) {
        return { rows: opts.gateRow ? [opts.gateRow] : [] };
      }
      if (/UPDATE worker_message_intents/.test(sql)) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    return { query, calls };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/twilio',
      DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    };
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC12345',
        authToken: 'test-auth-token',
        messagingServiceSid: 'MGtest12345',
        templates: { job_alert_es: JOB_ALERT_SID_ES, job_alert_en: JOB_ALERT_SID_EN },
      }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('a v2-disabled worker follows the legacy outbox path byte-for-byte and creates no intent row', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: false });
    mockConnect.mockResolvedValue({ query, release: mockRelease });

    const result = await handler({ jobId: 'job-1' });

    expect(result).toEqual({ queued: 1, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(false);
    const legacyInsert = calls.find((c) => /INSERT INTO whatsapp_outbox/.test(c.sql) && c.sql.includes("'job_alert'"));
    expect(legacyInsert).toBeDefined();
  });


  it('does not send a v2-ready-only candidate through the legacy outbox when rollout is disabled', async () => {
    const { query, calls } = scriptedClient({
      v2GlobalEnabled: false,
      workers: [{
        id: V2_WORKER,
        whatsapp_number: V2_PHONE,
        language: 'es',
        main_trade: null,
        legacy_ready: null,
      }],
    });
    mockConnect.mockResolvedValue({ query, release: mockRelease });

    await expect(handler({ jobId: 'job-1' })).resolves.toEqual({ queued: 0, skipped: 1 });
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO worker_message_intents/.test(c.sql))).toBe(false);
  });
  it('a v2-enabled worker creates exactly one worker_message_intents row with the exact dedupe key and expiry, and issues no whatsapp_outbox insert / no fetch', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: true });
    mockConnect.mockResolvedValue({ query, release: mockRelease });
    const beforeMs = Date.now();

    const result = await handler({ jobId: 'job-1' });

    expect(result).toEqual({ queued: 1, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);

    const intentInserts = calls.filter((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    expect(intentInserts).toHaveLength(1);
    const params = intentInserts[0].params;
    // (user_id, category, owner_service, source_type, source_id, dedupe_key,
    //  priority, status, policy_version, payload, expires_at)
    expect(params[0]).toBe(V2_WORKER);
    expect(params[1]).toBe('job_alert');
    expect(params[2]).toBe('job-alert');
    expect(params[3]).toBe('job');
    expect(params[4]).toBe('job-1');
    expect(params[5]).toBe(`job-alert:job-1:${V2_WORKER}`);
    expect(params[6]).toBe(30);
    expect(JSON.parse(params[8] as string)).toEqual({
      jobs: [{
        jobId: 'job-1',
        title: 'Electricista',
        companyName: 'ACME',
        score: 1,
        // location/pay feed the v1 job_alert_* content template in the v2
        // renderer (single-job alerts must be template sends to reach
        // workers outside the 24h window).
        location: 'Austin',
        pay: '$40/hr',
      }],
    });
    const expiresAt = params[9] as Date;
    const expectedExpiryMs = beforeMs + 72 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt.getTime() - expectedExpiryMs)).toBeLessThan(5000);
    const beginIndex = calls.findIndex((c) => c.sql === 'BEGIN');
    const contextIndex = calls.findIndex((c) =>
      c.sql.includes("set_config('app.current_internal_user_id'") &&
      c.params[0] === V2_WORKER);
    const intentIndex = calls.findIndex((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    const commitIndex = calls.findIndex((c) => c.sql === 'COMMIT');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThan(beginIndex);
    expect(intentIndex).toBeGreaterThan(contextIndex);
    expect(commitIndex).toBeGreaterThan(intentIndex);
  });

  it('a repeated producer call for a v2-enabled worker does not create a second intent (ON CONFLICT no-op)', async () => {
    const { query, calls } = scriptedClient({ v2GlobalEnabled: true });
    mockConnect.mockResolvedValue({ query, release: mockRelease });

    await handler({ jobId: 'job-1' });
    await handler({ jobId: 'job-1' });

    const intentInserts = calls.filter((c) => /INSERT INTO worker_message_intents/.test(c.sql));
    // Both calls issue the idempotent ON CONFLICT insert; the dedupe_key is
    // identical both times, which is what the UNIQUE constraint enforces at
    // the database layer (a real DB would return the same row id both times).
    expect(intentInserts).toHaveLength(2);
    expect(intentInserts[0].params[5]).toBe(intentInserts[1].params[5]);
    expect(calls.some((c) => /INSERT INTO whatsapp_outbox/.test(c.sql))).toBe(false);
  });
  it('attempts every v2 worker, then rejects with a stable aggregate when any enqueue fails', async () => {
    const workers = [
      { id: 'worker-c', whatsapp_number: '+15125550003', language: 'es' as const, main_trade: null },
      { id: 'worker-a', whatsapp_number: '+15125550001', language: 'es' as const, main_trade: null },
      { id: 'worker-b', whatsapp_number: '+15125550002', language: 'en' as const, main_trade: null },
    ];
    const { query, calls } = scriptedClient({
      v2GlobalEnabled: true,
      workers,
      failWorkerIds: ['worker-c', 'worker-a'],
    });
    mockConnect.mockResolvedValue({ query, release: mockRelease });

    let caught: unknown;
    try {
      await handler({ jobId: 'job-1' });
    } catch (error) {
      caught = error;
    }

    const attemptedWorkerIds = calls
      .filter((c) => /INSERT INTO worker_message_intents/.test(c.sql))
      .map((c) => c.params[0]);
    expect(attemptedWorkerIds).toEqual(['worker-c', 'worker-a', 'worker-b']);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({ message: 'job_alert_fanout_failed' });
    expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      'worker-a: intent failure worker-a',
      'worker-c: intent failure worker-c',
    ]);
  });
});
