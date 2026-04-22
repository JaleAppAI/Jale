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

// Mock global fetch (used by Twilio API send)
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/job-alert';

const JOB_ALERT_SID_ES = 'HXe94c8d14f1c84fb5dfc8909f9797a093';
const JOB_ALERT_SID_EN = 'HXd6fde4e795ec66d140b628536c3cff5b';

describe('Job Alert Sender Lambda', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/twilio',
      DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/db',
    };

    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });

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

    // Default fetch success
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => 'OK',
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns early with no send when jobId is missing', async () => {
    const result = await handler({});
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns early when the job does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // job lookup

    const result = await handler({ jobId: 'nonexistent' });
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends Spanish template to Spanish-language worker', async () => {
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
      });

    const result = await handler({ jobId: 'job-uuid-1' });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC12345/Messages.json');

    // Parse the form body
    const body = new URLSearchParams(opts.body);
    expect(body.get('MessagingServiceSid')).toBe('MGtest12345');
    expect(body.get('From')).toBeNull();
    expect(body.get('To')).toBe('whatsapp:+15125551234');
    expect(body.get('ContentSid')).toBe(JOB_ALERT_SID_ES);

    const vars = JSON.parse(body.get('ContentVariables')!);
    expect(vars).toEqual({
      '1': 'Electricista',
      '2': 'Martinez Construction',
      '3': 'Downtown, Houston',
      '4': '$35/hr',
      '5': 'job-job-uuid-1',
    });
  });

  it('sends English template to English-language worker', async () => {
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
      });

    const result = await handler({ jobId: 'j1' });
    expect(result).toEqual({ sent: 1, skipped: 0 });

    const [, opts] = mockFetch.mock.calls[0];
    const body = new URLSearchParams(opts.body);
    expect(body.get('ContentSid')).toBe(JOB_ALERT_SID_EN);
  });

  it('sends correct template per worker when sending to a mix', async () => {
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
      });

    const result = await handler({ jobId: 'j1' });
    expect(result).toEqual({ sent: 2, skipped: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const sids = mockFetch.mock.calls.map(([, opts]) => {
      const body = new URLSearchParams(opts.body);
      return body.get('ContentSid');
    });
    expect(sids).toContain(JOB_ALERT_SID_ES);
    expect(sids).toContain(JOB_ALERT_SID_EN);
  });

  it('counts skipped when Twilio returns an error', async () => {
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
      });

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => 'OK' })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Rate limit' });

    const result = await handler({ jobId: 'j1' });

    expect(result).toEqual({ sent: 1, skipped: 1 });
  });

  it('throws when job_alert template SIDs are missing from the Twilio secret', async () => {
    // The module-level cachedTwilio persists across tests; isolate the
    // module to get a fresh (empty) cache for this scenario.
    jest.isolateModules(() => {
      // No-op — we'll re-require inside the async block below
    });
    jest.resetModules();

    // Re-apply mocks after resetModules (they're scoped to the module registry).
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

    // Re-require to get a fresh module with an empty cache
    const { handler: freshHandler } = require('../../../../lambda/whatsapp/job-alert');
    await expect(freshHandler({ jobId: 'j1' })).rejects.toThrow('job_alert_es and job_alert_en');
  });

  it('returns zero sends when no workers match', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await handler({ jobId: 'j1' });

    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('constructs Basic auth header from accountSid:authToken', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'j1', title: 'T', company: 'C', location: 'L', pay: '$1' }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'w1', whatsapp_number: '+1001', language: 'es', main_trade: null }],
      });

    await handler({ jobId: 'j1' });

    const [, opts] = mockFetch.mock.calls[0];
    const expectedAuth = 'Basic ' + Buffer.from('AC12345:test-auth-token').toString('base64');
    expect(opts.headers.Authorization).toBe(expectedAuth);
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
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
