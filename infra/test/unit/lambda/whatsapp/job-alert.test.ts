// Mock AWS SDK clients + shared db module BEFORE importing the handler
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValueCommand' })),
}));

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: jest.fn(),
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
          language: 'en', main_trade: 'electrician',
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
          { id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null },
          { id: 'w2', whatsapp_number: '+1002', language: 'en', main_trade: null },
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
          { id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null },
          { id: 'w2', whatsapp_number: '+1002', language: 'en', main_trade: null },
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
        rows: [{ id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null }],
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
