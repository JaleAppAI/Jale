const send = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send })),
  TransactWriteItemsCommand: jest.fn((input) => ({ input })),
}));

import { checkOtpRateLimit } from '../../../../lambda/auth/lib/otp-rate-limit';

describe('OTP rate limiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OTP_RATE_LIMIT_TABLE_NAME = 'otp-rate-limit';
  });

  it('atomically increments minute, hour, and day windows', async () => {
    send.mockResolvedValueOnce({});

    await expect(checkOtpRateLimit('+15125551234', new Date('2026-06-15T12:34:20Z')))
      .resolves.toEqual({ allowed: true });

    const transaction = send.mock.calls[0][0].input.TransactItems;
    expect(transaction).toHaveLength(3);
    expect(transaction.map((item: any) => item.Update.Key.window.S)).toEqual([
      'MINUTE#2026-06-15T12:34',
      'HOUR#2026-06-15T12',
      'DAY#2026-06-15',
    ]);
    expect(transaction.map((item: any) => item.Update.ExpressionAttributeValues[':limit'].N))
      .toEqual(['1', '5', '20']);
  });

  it.each([
    [0, 'cooldown', 40],
    [1, 'hourly', 1540],
    [2, 'daily', 41140],
  ])('maps conditional failure %i to %s throttling', async (failedIndex, reason, retryAfterSeconds) => {
    const cancellationReasons = Array.from({ length: 3 }, (_, index) => ({
      Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None',
    }));
    send.mockRejectedValueOnce(Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: cancellationReasons,
    }));

    await expect(checkOtpRateLimit('+15125551234', new Date('2026-06-15T12:34:20Z')))
      .resolves.toEqual({ allowed: false, reason, retryAfterSeconds });
  });
});
