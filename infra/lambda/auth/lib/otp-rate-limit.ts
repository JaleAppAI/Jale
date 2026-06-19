import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { createHash } from 'node:crypto';

export type OtpRateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      reason: 'cooldown' | 'hourly' | 'daily';
    };

type DynamoClient = {
  send(command: unknown): Promise<unknown>;
};

const dynamo = new DynamoDBClient({});

export async function checkOtpRateLimit(
  phone: string,
  now = new Date(),
  client: DynamoClient = dynamo,
): Promise<OtpRateLimitDecision> {
  const tableName = process.env.OTP_RATE_LIMIT_TABLE_NAME;
  if (!tableName) {
    throw new Error('OTP_RATE_LIMIT_TABLE_NAME not set');
  }

  const subject = `PHONE#${createHash('sha256').update(phone).digest('hex')}`;
  const windows = buildWindows(now);
  const transaction = new TransactWriteItemsCommand({
    TransactItems: windows.map((window) => ({
      Update: {
        TableName: tableName,
        Key: {
          subject: { S: subject },
          window: { S: window.key },
        },
        UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: {
          '#count': 'count',
        },
        ExpressionAttributeValues: {
          ':zero': { N: '0' },
          ':one': { N: '1' },
          ':limit': { N: String(window.limit) },
          ':expiresAt': { N: String(window.expiresAt) },
        },
      },
    })),
  });

  try {
    await client.send(transaction);
    return { allowed: true };
  } catch (error: any) {
    if (error?.name !== 'TransactionCanceledException') {
      throw error;
    }
    const reasons = error.CancellationReasons ?? error.cancellationReasons ?? [];
    const failedIndex = reasons.findIndex((reason: { Code?: string }) => reason.Code === 'ConditionalCheckFailed');
    if (failedIndex < 0 || failedIndex >= windows.length) {
      throw error;
    }
    const failed = windows[failedIndex];
    return {
      allowed: false,
      reason: failed.reason,
      retryAfterSeconds: Math.max(1, Math.ceil((failed.boundaryMs - now.getTime()) / 1000)),
    };
  }
}

function buildWindows(now: Date) {
  const iso = now.toISOString();
  const minuteBoundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes() + 1,
  );
  const hourBoundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1,
  );
  const dayBoundary = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );

  return [
    {
      key: `MINUTE#${iso.slice(0, 16)}`,
      limit: 1,
      reason: 'cooldown' as const,
      boundaryMs: minuteBoundary,
      expiresAt: Math.floor(minuteBoundary / 1000) + 120,
    },
    {
      key: `HOUR#${iso.slice(0, 13)}`,
      limit: 5,
      reason: 'hourly' as const,
      boundaryMs: hourBoundary,
      expiresAt: Math.floor(hourBoundary / 1000) + 7200,
    },
    {
      key: `DAY#${iso.slice(0, 10)}`,
      limit: 20,
      reason: 'daily' as const,
      boundaryMs: dayBoundary,
      expiresAt: Math.floor(dayBoundary / 1000) + 172800,
    },
  ];
}
