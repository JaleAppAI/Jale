const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input) => ({ input, __type: 'GetSecretValue' })),
}));

const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  UpdateItemCommand: jest.fn((input) => ({ input, __type: 'UpdateItem' })),
}));

const validateTwilioSignature = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/twilio', () => ({
  parseFormBody: (raw: string) => Object.fromEntries(new URLSearchParams(raw).entries()),
  reconstructWebhookUrl: () => 'https://callback.example.com/',
  validateTwilioSignature: (...args: unknown[]) => validateTwilioSignature(...args),
}));

import { handler } from '../../../../lambda/auth/otp-status-callback';

describe('OTP status callback Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'jale/whatsapp/otp-twilio';
    process.env.OTP_DELIVERY_STATUS_TABLE_NAME = 'otp-delivery-status';
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({ accountSid: 'ACtest', authToken: 'test-token' }),
    });
    mockDynamoSend.mockResolvedValue({});
    validateTwilioSignature.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.TWILIO_SECRET_ARN;
    delete process.env.OTP_DELIVERY_STATUS_TABLE_NAME;
  });

  function event(body: string) {
    return {
      body,
      isBase64Encoded: false,
      headers: { 'X-Twilio-Signature': 'sig' },
      requestContext: { domainName: 'callback.example.com', path: '/' },
    } as any;
  }

  it('rejects invalid Twilio signatures without updating DynamoDB', async () => {
    validateTwilioSignature.mockReturnValueOnce(false);

    const result = await handler(event('MessageSid=SM123&MessageStatus=delivered'));

    expect(result.statusCode).toBe(403);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('requires MessageSid and MessageStatus', async () => {
    const result = await handler(event('MessageSid=SM123'));

    expect(result.statusCode).toBe(400);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('updates delivery status and emits failure metric for undelivered callbacks', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await handler(event('MessageSid=SM123&MessageStatus=undelivered&ErrorCode=30003&ErrorMessage=Unreachable%20destination%20handset'));

    expect(result.statusCode).toBe(200);
    expect(mockDynamoSend).toHaveBeenCalledWith(expect.objectContaining({ __type: 'UpdateItem' }));
    const command = mockDynamoSend.mock.calls[0][0];
    expect(command.input.TableName).toBe('otp-delivery-status');
    expect(command.input.Key.twilioMessageSid.S).toBe('SM123');
    expect(command.input.ExpressionAttributeValues[':status'].S).toBe('undelivered');
    expect(command.input.ExpressionAttributeValues[':errorCode'].S).toBe('30003');
    expect(JSON.stringify(logSpy.mock.calls)).toContain('WorkerOtpDeliveryFailed');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('+1915');

    logSpy.mockRestore();
  });

  it('emits delivered metric for delivered callbacks', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await handler(event('MessageSid=SM123&MessageStatus=delivered'));

    expect(result.statusCode).toBe(200);
    expect(JSON.stringify(logSpy.mock.calls)).toContain('WorkerOtpDelivered');

    logSpy.mockRestore();
  });
});
