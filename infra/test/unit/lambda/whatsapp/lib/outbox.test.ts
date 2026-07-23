const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  AmbiguousTwilioSendError,
  drainJobAlertOutbox,
  drainWorkerIntentOutbox,
  sendTwilioWhatsAppMessage,
  sendPendingAdminOutbox,
  sendPendingOutbox,
  insertAuthorizedIntentOutbox,
  _clearOutboxTwilioSecretCacheForTests,
} from '../../../../../lambda/whatsapp/lib/outbox';

describe('worker-intent outbox drain', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_REQUEST_TIMEOUT_MS: '4000',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
    };
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test', authToken: 'tok_test',
        messagingServiceSid: 'MG_test', templates: {},
      }),
    });
  });

  afterAll(() => { process.env = originalEnv; });

  it('leases through the definer RPC, sends once, and completes with the fencing token', async () => {
    const sid = `SM${'1'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-1',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ completed: true }] });
    const release = jest.fn();
    const pool = { connect: jest.fn(async () => ({ query, release })) };

    await expect(drainWorkerIntentOutbox(pool as any, 25)).resolves.toEqual({
      sent: 1, ambiguous: 0, failed: 0, leaseLost: 0,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      'SELECT * FROM lease_worker_intent_outbox($1)', [25],
    ]);
    expect(query.mock.calls[1]).toEqual([
      'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
      ['outbox-1', 'lease-1', sid],
    ]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('records an ambiguous transport failure and never completes the row', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-2', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-2',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0, leaseLost: 0,
    });
    expect(query.mock.calls[1][0]).toBe(
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
    );
    expect(query.mock.calls[1][1][3]).toBe(true);
  });

  it('never requeues after Twilio accepts when completion persistence fails', async () => {
    const sid = `SM${'3'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-3', whatsapp_number: '+15125551234', body: 'hello',
          content_template: null, content_variables: null, attempt_count: 1,
          lease_token: 'lease-3',
        }],
      })
      .mockRejectedValueOnce(new Error('completion database unavailable'))
      .mockResolvedValueOnce({ rows: [{ failed: true }] });
    const pool = { connect: jest.fn(async () => ({ query, release: jest.fn() })) };

    await expect(drainWorkerIntentOutbox(pool as any)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0, leaseLost: 0,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[2]).toEqual([
      'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
      ['outbox-3', 'lease-3', 'completion database unavailable', true],
    ]);
  });
});

describe('whatsapp outbox templates', () => {
  const originalEnv = process.env;
  const query = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = { ...originalEnv, TWILIO_SECRET_ARN: 'arn:twilio' };
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '4000';
    process.env.TWILIO_STATUS_CALLBACK_URL =
      'https://callbacks.example.test/prod/whatsapp/status-callback';
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MG_test',
        templates: {
          job_alert_en: 'HX_job_en',
          admin_support_reply_en: 'HX_admin_en',
        },
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK', json: async () => ({ sid: 'SM11111111111111111111111111111111' }) });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('accepts an MM-prefixed Twilio message SID', async () => {
    const sid = `MM${'a'.repeat(32)}`;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sid }) });

    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125551234', {
      body: 'Hello',
      content_template: null,
      content_variables: null,
    })).resolves.toBe(sid);
  });

  it('keeps malformed Twilio message SIDs ambiguous', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sid: `MM${'g'.repeat(32)}` }),
    });

    await expect(sendTwilioWhatsAppMessage('whatsapp:+15125551234', {
      body: 'Hello',
      content_template: null,
      content_variables: null,
    })).rejects.toBeInstanceOf(AmbiguousTwilioSendError);
  });

  it('sends Twilio Content API templates from outbox rows', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-1',
          sequence: 1,
          whatsapp_number: '+15125551234',
          body: null,
          content_template: 'job_alert_en',
          content_variables: { '1': 'Drywall finisher', '5': 'job-job-1' },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await sendPendingOutbox({ query } as any, 'SM-template');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('ContentSid=HX_job_en'),
      }),
    );
    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('ContentVariables=');
    expect(sentBody).toContain(
      'StatusCallback=https%3A%2F%2Fcallbacks.example.test%2Fprod%2Fwhatsapp%2Fstatus-callback',
    );
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-1', 'SM11111111111111111111111111111111']);
  });

  it('falls back to text when an in-session template SID is not configured', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: 'outbox-2',
          sequence: 1,
          whatsapp_number: '+15125551234',
          body: null,
          content_template: 'onboarding_trade_en',
          content_variables: {
            __fallback_body: 'What is your main trade?\n\n1. Electrician',
          },
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await sendPendingOutbox({ query } as any, 'SM-template-fallback');

    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('Body=What+is+your+main+trade');
    expect(sentBody).not.toContain('ContentSid=');
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-2', 'SM11111111111111111111111111111111']);
  });

  it('drains admin-originated rows independently of inbound message rows', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM whatsapp_outbox')) {
        if (query.mock.calls.filter(([callSql]) => String(callSql).includes('FROM whatsapp_outbox')).length === 1) {
          return { rows: [{
          id: 'outbox-admin-1',
          sequence: 0,
          whatsapp_number: '+151****1234',
          body: 'Admin follow-up',
          content_template: null,
          content_variables: null,
          }] };
        }
        return { rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    await sendPendingAdminOutbox({ query } as any);

    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("source_type = 'admin_case'"),
      [5],
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['outbox-admin-1', 'SM11111111111111111111111111111111'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('record_admin_whatsapp_delivery'),
      ['outbox-admin-1', 'SM11111111111111111111111111111111'],
    );
  });

  it('sends admin support replies with Content API templates when configured', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM whatsapp_outbox')) {
        if (query.mock.calls.filter(([callSql]) => String(callSql).includes('FROM whatsapp_outbox')).length === 1) {
          return { rows: [{
            id: 'outbox-admin-template',
            sequence: 0,
            whatsapp_number: '+151****1234',
            body: null,
            content_template: 'admin_support_reply_en',
            content_variables: {
              '1': 'Please send the missing document.',
              __fallback_body: 'Please send\nthe missing document.',
            },
          }] };
        }
        return { rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    await sendPendingAdminOutbox({ query } as any);

    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('ContentSid=HX_admin_en');
    expect(sentBody).toContain('ContentVariables=');
    expect(sentBody).not.toContain('__fallback_body');
    expect(sentBody).not.toContain('Body=');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['outbox-admin-template', 'SM11111111111111111111111111111111'],
    );
  });

  it('falls back to freeform body for admin support replies while template SID is missing', async () => {
    mockSecretsSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MG_test',
        templates: { job_alert_en: 'HX_job_en' },
      }),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM whatsapp_outbox')) {
        if (query.mock.calls.filter(([callSql]) => String(callSql).includes('FROM whatsapp_outbox')).length === 1) {
          return { rows: [{
            id: 'outbox-admin-fallback',
            sequence: 0,
            whatsapp_number: '+151****1234',
            body: null,
            content_template: 'admin_support_reply_en',
            content_variables: {
              '1': 'Please send the missing document.',
              __fallback_body: 'Please send\nthe missing document.',
            },
          }] };
        }
        return { rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    await sendPendingAdminOutbox({ query } as any);

    const sentBody = mockFetch.mock.calls[0][1].body as string;
    expect(sentBody).toContain('Body=Please+send%0Athe+missing+document.');
    expect(sentBody).not.toContain('ContentSid=');
  });

  it('records an ambiguous state instead of retryable failure when Twilio times out', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM whatsapp_outbox')) {
        if (query.mock.calls.filter(([callSql]) => String(callSql).includes('FROM whatsapp_outbox')).length === 1) {
          return { rows: [{
          id: 'outbox-admin-timeout',
          sequence: 0,
          whatsapp_number: '+15125551234',
          body: 'Admin follow-up',
          content_template: null,
          content_variables: null,
          }] };
        }
        return { rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    await sendPendingAdminOutbox({ query } as any);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $1'),
      ['send_unknown', expect.stringContaining('delivery state unknown'), 'outbox-admin-timeout'],
    );
  });

  it('commits each admin outbox row independently', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => 'OK', json: async () => ({ sid: 'SM22222222222222222222222222222222' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Twilio 500' });
    const rows = [
      {
        id: 'outbox-admin-first',
        sequence: 0,
        whatsapp_number: '+15125551234',
        body: 'First admin follow-up',
        content_template: null,
        content_variables: null,
      },
      {
        id: 'outbox-admin-second',
        sequence: 0,
        whatsapp_number: '+15125554321',
        body: 'Second admin follow-up',
        content_template: null,
        content_variables: null,
      },
    ];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM whatsapp_outbox')) {
        const row = rows.shift();
        return { rows: row ? [row] : [] };
      }
      return { rowCount: 1, rows: [] };
    });

    await sendPendingAdminOutbox({ query } as any);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql === 'BEGIN')).toHaveLength(3);
    expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(3);
    const firstCommitIndex = statements.indexOf('COMMIT');
    const secondFailureIndex = query.mock.calls.findIndex(([, params]) =>
      Array.isArray(params) && params.includes('outbox-admin-second'));
    expect(firstCommitIndex).toBeLessThan(secondFailureIndex);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['outbox-admin-first', 'SM22222222222222222222222222222222'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $1'),
      ['failed', 'Twilio send failed with HTTP 500', 'outbox-admin-second'],
    );
  });

  function jobAlertPool(attemptCount = 0) {
    const events: string[] = [];
    const claimQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      events.push(sql);
      if (sql.includes('SELECT id, whatsapp_number')) {
        return {
          rows: [{
            id: 'job-alert-row',
            whatsapp_number: '+15125551234',
            body: 'A new job is available',
            content_template: null,
            content_variables: null,
            attempt_count: attemptCount,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const resultQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      events.push(sql);
      return { rowCount: 1, rows: [] };
    });
    const clients = [
      { query: claimQuery, release: jest.fn() },
      { query: resultQuery, release: jest.fn() },
    ];
    const pool = { connect: jest.fn(async () => clients.shift()!) };
    return { pool, claimQuery, resultQuery, events };
  }

  it('claims only pending job alerts with SKIP LOCKED and commits before sending', async () => {
    const { pool, claimQuery, resultQuery, events } = jobAlertPool();
    mockFetch.mockImplementationOnce(async () => {
      events.push('TWILIO_SEND');
      return {
        ok: true,
        json: async () => ({ sid: 'SM33333333333333333333333333333333' }),
      };
    });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 1, ambiguous: 0, failed: 0,
    });

    const selectSql = String(claimQuery.mock.calls.find(([sql]) => sql.includes('SELECT id'))![0]);
    expect(selectSql).toContain("status = 'pending'");
    expect(selectSql).not.toContain("'send_unknown'");
    expect(selectSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(events.indexOf('COMMIT')).toBeLessThan(events.indexOf('TWILIO_SEND'));
    expect(claimQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'send_unknown'"),
      ['job-alert-row'],
    );
    expect(resultQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ['job-alert-row', 'SM33333333333333333333333333333333'],
    );
  });

  it('leaves an ambiguous job-alert send terminally send_unknown without backoff', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'send_unknown'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('next_attempt_at = NULL');
    expect(String(update![0])).not.toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('valid message SID')]);
  });

  it('treats a rejected Twilio fetch as ambiguous and never schedules a resend', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed: socket terminated'));

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 1, failed: 0,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'send_unknown'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('next_attempt_at = NULL');
    expect(String(update![0])).not.toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('delivery state unknown')]);
  });

  it('retries definite non-acceptance with backoff while below the attempt cap', async () => {
    const { pool, resultQuery } = jobAlertPool();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
    });

    const update = resultQuery.mock.calls.find(([sql]) => sql.includes("status = 'pending'"));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('milliseconds');
    expect(update![1]).toEqual(['job-alert-row', expect.stringContaining('HTTP 503'), '30000']);
  });

  it('marks definite non-acceptance failed at the attempt cap', async () => {
    const { pool, resultQuery } = jobAlertPool(4);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid' });

    await expect(drainJobAlertOutbox(pool as any, 1)).resolves.toEqual({
      sent: 0, ambiguous: 0, failed: 1,
    });

    expect(resultQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      ['job-alert-row', expect.stringContaining('HTTP 400')],
    );
  });

  describe('insertAuthorizedIntentOutbox', () => {
    it('inserts a worker_intent outbox row for an eligible intent', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ status: 'eligible' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-worker-intent-1' }] });

      const result = await insertAuthorizedIntentOutbox({ query } as any, 'intent-1', {
        whatsappNumber: '+15125551234',
        body: 'A new job is available',
        contentTemplate: null,
        contentVariables: null,
      });

      expect(result).toEqual({ outboxId: 'outbox-worker-intent-1' });
      expect(query.mock.calls[0][0]).toMatch(/SELECT status FROM worker_message_intents/);
      expect(query.mock.calls[0][1]).toEqual(['intent-1']);
      const insertCall = query.mock.calls[1];
      expect(insertCall[0]).toMatch(/INSERT INTO whatsapp_outbox/);
      expect(insertCall[0]).toMatch(/'worker_intent'/);
      expect(insertCall[1]).toEqual([
        '+15125551234',
        'A new job is available',
        null,
        null,
        'intent-1',
      ]);
    });

    it('throws unauthorized_worker_outbox_row when the intent is still deferred', async () => {
      query.mockResolvedValueOnce({ rows: [{ status: 'deferred' }] });

      await expect(insertAuthorizedIntentOutbox({ query } as any, 'intent-2', {
        whatsappNumber: '+15125551234',
        body: 'hi',
        contentTemplate: null,
        contentVariables: null,
      })).rejects.toThrow('unauthorized_worker_outbox_row');

      expect(query.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO whatsapp_outbox'))).toHaveLength(0);
    });

    it('throws unauthorized_worker_outbox_row when no intent row exists', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(insertAuthorizedIntentOutbox({ query } as any, 'intent-missing', {
        whatsappNumber: '+15125551234',
        body: 'hi',
        contentTemplate: null,
        contentVariables: null,
      })).rejects.toThrow('unauthorized_worker_outbox_row');
    });
  });
});
