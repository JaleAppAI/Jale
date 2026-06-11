import type { CreateAuthChallengeTriggerEvent } from 'aws-lambda';

// ── Mock Secrets Manager client BEFORE importing the handler ──────────────
// Twilio credentials are loaded from Secrets Manager (`jale/whatsapp/otp-twilio`).
// These tests stub the SDK to exercise cache hits, missing secrets, and malformed
// payloads without a real AWS call.
const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

import { handler, _clearSecretCacheForTests } from '../../../../lambda/auth/create-auth-challenge';

describe('CreateAuthChallenge Lambda', () => {
  const baseEvent = (session: any[] = []): CreateAuthChallengeTriggerEvent => ({
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    userName: 'test-user',
    callerContext: { awsSdkVersion: '1', clientId: 'client-id' },
    triggerSource: 'CreateAuthChallenge_Authentication',
    request: {
      userAttributes: { phone_number: '+15125551234' },
      challengeName: 'CUSTOM_CHALLENGE',
      session,
    } as any,
    response: {} as any,
  });

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ sid: 'SMxxxxxxxxxxxxxxxx' }),
    });
    (global as any).fetch = fetchMock;

    // Default: TWILIO_SECRET_ARN env var set to the secret name; secret returns the full payload.
    process.env.TWILIO_SECRET_ARN = 'jale/whatsapp/otp-twilio';
    process.env.TWILIO_FROM_NUMBER = '+13252210992';
    mockSecretsSend.mockReset();
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'ACtest',
        authToken: 'test-token',
        messagingServiceSid: 'MGtest1234567890',
      }),
    });
    _clearSecretCacheForTests();
  });

  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.TWILIO_SECRET_ARN;
    delete process.env.TWILIO_FROM_NUMBER;
  });

  it('generates a 6-digit OTP and sends SMS from the dedicated Jale number on first call', async () => {
    const event = baseEvent([]);
    const result = await handler(event);

    // OTP should be 6 digits
    const otp = result.response.privateChallengeParameters?.otp;
    expect(otp).toMatch(/^\d{6}$/);

    // Twilio fetch was called exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(init.method).toBe('POST');

    // Basic Auth header uses accountSid:authToken FROM THE SECRET
    const expectedAuth = 'Basic ' + Buffer.from('ACtest:test-token').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedAuth);

    // Form body contains recipient WhatsApp address, Messaging Service SID from secret, and OTP.
    // Twilio Messages API rejects requests that specify both From and MessagingServiceSid.
    // OTP delivery must use the dedicated From number, never the WhatsApp service.
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+15125551234');
    expect(body.get('From')).toBe('+13252210992');
    expect(body.get('MessagingServiceSid')).toBeNull();
    expect(body.get('Body')).toContain(otp!);
    expect(body.get('Body')).not.toContain('Reply');

    // challengeMetadata carries the OTP forward for retry reuse
    expect(result.response.challengeMetadata).toBe(otp);
  });

  it('caches the Secrets Manager fetch across invocations within the TTL', async () => {
    await handler(baseEvent([]));
    await handler(baseEvent([]));
    await handler(baseEvent([]));

    // 3 OTP invocations but only one Secrets Manager fetch (cached after first).
    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing OTP on retry (does not regenerate or re-send SMS)', async () => {
    const existingOtp = '654321';
    const event = baseEvent([
      {
        challengeName: 'CUSTOM_CHALLENGE',
        challengeResult: false,
        challengeMetadata: existingOtp,
      },
    ]);
    const result = await handler(event);

    expect(result.response.privateChallengeParameters?.otp).toBe(existingOtp);
    expect(result.response.challengeMetadata).toBe(existingOtp);
    // No WhatsApp message sent on retry
    expect(fetchMock).not.toHaveBeenCalled();
    // No Secrets Manager call either on retry (OTP reused, Twilio not invoked).
    expect(mockSecretsSend).not.toHaveBeenCalled();
  });

  it('masks the phone in the public hint', async () => {
    const event = baseEvent([]);
    const result = await handler(event);

    expect(result.response.publicChallengeParameters?.hint).toMatch(
      /SMS sent to \+1\*\*\*1234/,
    );
  });

  it('throws if phone_number attribute is missing', async () => {
    const event = baseEvent([]);
    event.request.userAttributes = {} as any;

    await expect(handler(event)).rejects.toThrow('Missing phone_number');
  });

  it('does not leak the OTP into publicChallengeParameters', async () => {
    const event = baseEvent([]);
    const result = await handler(event);

    const otp = result.response.privateChallengeParameters?.otp;
    const publicHint = result.response.publicChallengeParameters?.hint ?? '';
    expect(publicHint).not.toContain(otp);
  });

  it('throws a descriptive error when Twilio returns non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Authenticate', code: 20003 }),
    });
    const event = baseEvent([]);
    await expect(handler(event)).rejects.toThrow(
      /Twilio SMS OTP send failed.*Authenticate/,
    );
  });

  it('throws if TWILIO_SECRET_ARN is missing', async () => {
    delete process.env.TWILIO_SECRET_ARN;
    const event = baseEvent([]);
    await expect(handler(event)).rejects.toThrow(/Missing TWILIO_SECRET_ARN/);
  });

  it('throws if the secret payload is missing required fields', async () => {
    mockSecretsSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({
        accountSid: 'ACtest',
        // authToken missing
      }),
    });
    const event = baseEvent([]);
    await expect(handler(event)).rejects.toThrow(
      /missing required fields accountSid\/authToken/,
    );
  });

  it('throws if the secret has no SecretString', async () => {
    mockSecretsSend.mockResolvedValueOnce({});
    const event = baseEvent([]);
    await expect(handler(event)).rejects.toThrow(/no SecretString/);
  });
});
