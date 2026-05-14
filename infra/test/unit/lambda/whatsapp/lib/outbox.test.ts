const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { sendPendingOutbox, _clearOutboxTwilioSecretCacheForTests } from '../../../../../lambda/whatsapp/lib/outbox';

describe('whatsapp outbox templates', () => {
  const originalEnv = process.env;
  const query = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    _clearOutboxTwilioSecretCacheForTests();
    process.env = { ...originalEnv, TWILIO_SECRET_ARN: 'arn:twilio' };
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MG_test',
        templates: { job_alert_en: 'HX_job_en' },
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
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
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("SET status = 'sent'"), ['outbox-1']);
  });
});
