const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  sendPendingAdminOutbox,
  sendPendingOutbox,
  _clearOutboxTwilioSecretCacheForTests,
} from '../../../../../lambda/whatsapp/lib/outbox';

describe('whatsapp outbox templates', () => {
  const originalEnv = process.env;
  const query = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = { ...originalEnv, TWILIO_SECRET_ARN: 'arn:twilio' };
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '4000';
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
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK', json: async () => ({ sid: 'SM_sent' }) });
  });

  afterAll(() => {
    process.env = originalEnv;
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
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-1', 'SM_sent']);
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
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-2', 'SM_sent']);
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
      ['outbox-admin-1', 'SM_sent'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('record_admin_whatsapp_delivery'),
      ['outbox-admin-1', 'SM_sent'],
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
      ['outbox-admin-template', 'SM_sent'],
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
      .mockResolvedValueOnce({ ok: true, text: async () => 'OK', json: async () => ({ sid: 'SM_first' }) })
      .mockRejectedValueOnce(new Error('Twilio 500'));
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
      ['outbox-admin-first', 'SM_first'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $1'),
      ['failed', 'Twilio 500', 'outbox-admin-second'],
    );
  });
});
