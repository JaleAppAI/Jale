const send = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send })),
  GetSecretValueCommand: jest.fn((input) => ({ input })),
}));

import {
  _clearTwilioSecretCacheForTests,
  getTwilioSecret,
  requireTwilioStatusCallbackUrl,
} from '../../../../../lambda/whatsapp/lib/twilio-secret';

describe('shared Twilio secret and status callback config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    _clearTwilioSecretCacheForTests();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL:
        'https://callbacks.example.test/prod/whatsapp/status-callback',
    };
    send.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC123', authToken: 'token', messagingServiceSid: 'MG123',
      }),
    });
  });

  afterAll(() => { process.env = originalEnv; });

  test('caches a validated secret and preserves the explicit reset hook', async () => {
    await getTwilioSecret();
    await getTwilioSecret();
    expect(send).toHaveBeenCalledTimes(1);
    _clearTwilioSecretCacheForTests();
    await getTwilioSecret();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('returns the exact validated callback URL', () => {
    expect(requireTwilioStatusCallbackUrl()).toBe(
      'https://callbacks.example.test/prod/whatsapp/status-callback',
    );
  });

  test.each([
    undefined,
    'http://callbacks.example.test/whatsapp/status-callback',
    'https://callbacks.example.test/whatsapp/status-callback?x=1',
    'https://callbacks.example.test/whatsapp/wrong',
  ])('rejects missing or unsafe callback config: %s', (value) => {
    if (value === undefined) delete process.env.TWILIO_STATUS_CALLBACK_URL;
    else process.env.TWILIO_STATUS_CALLBACK_URL = value;
    expect(() => requireTwilioStatusCallbackUrl()).toThrow('TWILIO_STATUS_CALLBACK_URL');
  });

  test('rejects malformed secret JSON with stable taxonomy', async () => {
    send.mockResolvedValueOnce({ SecretString: '{bad' });
    await expect(getTwilioSecret()).rejects.toThrow('TWILIO secret is not valid JSON');
  });
});
