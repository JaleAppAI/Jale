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

const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand: jest.fn((input) => ({ input, __type: 'PutItem' })),
  TransactWriteItemsCommand: jest.fn((input) => ({ input, __type: 'TransactWriteItems' })),
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
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '3500';
    process.env.TWILIO_VALIDITY_PERIOD_SECONDS = '180';
    process.env.OTP_RATE_LIMIT_TABLE_NAME = 'otp-rate-limit';
    process.env.OTP_DELIVERY_STATUS_TABLE_NAME = 'otp-delivery-status';
    process.env.TWILIO_STATUS_CALLBACK_URL = 'https://otp-callback.example.com/';
    mockDynamoSend.mockReset();
    mockDynamoSend.mockResolvedValue({});
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
    delete process.env.TWILIO_REQUEST_TIMEOUT_MS;
    delete process.env.TWILIO_VALIDITY_PERIOD_SECONDS;
    delete process.env.OTP_RATE_LIMIT_TABLE_NAME;
    delete process.env.OTP_DELIVERY_STATUS_TABLE_NAME;
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
  });

  it('generates a 6-digit OTP and sends SMS from the dedicated Jale number on first call', async () => {
    const event = baseEvent([]);
    const result = await handler(event);

    // OTP should be 6 digits
    const otp = result.response.privateChallengeParameters?.otp;
    expect(otp).toMatch(/^\d{6}$/);

    // Twilio fetch was called exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(init.method).toBe('POST');

    // Basic Auth header uses accountSid:authToken FROM THE SECRET
    const expectedAuth = 'Basic ' + Buffer.from('ACtest:test-token').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedAuth);

    // Form body contains the E.164 recipient, dedicated SMS From number, and OTP.
    // Twilio Messages API rejects requests that specify both From and MessagingServiceSid.
    // OTP delivery must use the dedicated From number, never the WhatsApp service.
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe(event.request.userAttributes.phone_number);
    expect(body.get('To')).not.toContain('whatsapp:');
    expect(body.get('From')).toBe(process.env.TWILIO_FROM_NUMBER);
    expect(body.get('MessagingServiceSid')).toBeNull();
    expect(body.get('Body')).toContain(otp!);
    expect(body.get('Body')).not.toContain('Reply');
    expect(body.get('ValidityPeriod')).toBe('180');
    expect(body.get('StatusCallback')).toBe(process.env.TWILIO_STATUS_CALLBACK_URL);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // challengeMetadata carries the OTP forward for retry reuse
    expect(result.response.challengeMetadata).toBe(otp);

    const putItemCalls = mockDynamoSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command.__type === 'PutItem');
    expect(putItemCalls).toHaveLength(1);
    expect(putItemCalls[0].input.TableName).toBe('otp-delivery-status');
    expect(putItemCalls[0].input.Item.twilioMessageSid.S).toBe('SMxxxxxxxxxxxxxxxx');
    expect(putItemCalls[0].input.Item.phoneHint.S).toBe('+1***1234');
    expect(JSON.stringify(putItemCalls[0].input.Item)).not.toContain(otp!);
  });

  it('does not fail the Cognito challenge when delivery telemetry persistence fails after Twilio accepts', async () => {
    mockDynamoSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('dynamodb unavailable'));

    const result = await handler(baseEvent([]));

    expect(result.response.privateChallengeParameters?.otp).toMatch(/^\d{6}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('does not fetch credentials or send SMS when the shared quota is exhausted', async () => {
    mockDynamoSend.mockRejectedValueOnce(Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }],
    }));

    await expect(handler(baseEvent([]))).rejects.toThrow('Unable to send a verification code right now.');
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('uses a bounded Twilio request timeout below Cognito trigger timeout', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

    await handler(baseEvent([]));

    expect(timeoutSpy).toHaveBeenCalledWith(3500);
    timeoutSpy.mockRestore();
  });

  it('rejects invalid Twilio timeout configuration', async () => {
    process.env.TWILIO_REQUEST_TIMEOUT_MS = '5000';

    await expect(handler(baseEvent([]))).rejects.toThrow(
      /TWILIO_REQUEST_TIMEOUT_MS must be between 500 and 4000/,
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
