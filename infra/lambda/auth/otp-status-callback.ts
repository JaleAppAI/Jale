import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  parseFormBody,
  reconstructWebhookUrl,
  validateTwilioSignature,
} from '../whatsapp/lib/twilio';
import { getOtpTwilioSecret, emitOtpMetric, _clearSecretCacheForTests } from './lib/otp-twilio';

const dynamodb = new DynamoDBClient({});

export { _clearSecretCacheForTests };

export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : event.body ?? '';
    const params = parseFormBody(rawBody);
    const secret = await getOtpTwilioSecret();
    const fullUrl = reconstructCallbackUrl(event);
    const signature = event.headers?.['X-Twilio-Signature'] ?? event.headers?.['x-twilio-signature'];

    if (!validateTwilioSignature(fullUrl, params, signature, secret.authToken)) {
      emitOtpMetric('WorkerOtpCallbackRejected');
      return { statusCode: 403, body: 'invalid signature' };
    }

    const messageSid = params.MessageSid;
    const messageStatus = params.MessageStatus ?? params.SmsStatus;
    if (!messageSid || !messageStatus) {
      return { statusCode: 400, body: 'missing MessageSid or MessageStatus' };
    }

    await updateOtpDeliveryStatus({
      messageSid,
      messageStatus,
      errorCode: params.ErrorCode,
      errorMessage: params.ErrorMessage,
    });

    if (messageStatus === 'delivered') {
      emitOtpMetric('WorkerOtpDelivered');
    } else if (messageStatus === 'undelivered' || messageStatus === 'failed') {
      emitOtpMetric('WorkerOtpDeliveryFailed', { errorCode: params.ErrorCode ?? 'unknown' });
    } else {
      emitOtpMetric('WorkerOtpDeliveryStatus', { status: messageStatus });
    }

    return { statusCode: 200, body: 'ok' };
  } catch {
    // Delivery-status tracking is best-effort. Swallow internal errors and ack
    // so Twilio does not retry-storm the public callback; the lost row is telemetry only.
    emitOtpMetric('WorkerOtpCallbackError');
    return { statusCode: 200, body: 'ok' };
  }
};

function reconstructCallbackUrl(event: any): string {
  const configured = process.env.TWILIO_STATUS_CALLBACK_URL;
  if (configured) {
    return configured;
  }
  const domain = event.requestContext?.domainName;
  const rawPath = event.rawPath ?? event.requestContext?.http?.path;
  if (domain && rawPath) {
    return `https://${domain}${rawPath}`;
  }
  return reconstructWebhookUrl(event.requestContext ?? {}, event.headers ?? {});
}

async function updateOtpDeliveryStatus(input: {
  messageSid: string;
  messageStatus: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const tableName = process.env.OTP_DELIVERY_STATUS_TABLE_NAME;
  if (!tableName) {
    throw new Error('Missing OTP_DELIVERY_STATUS_TABLE_NAME');
  }
  const now = new Date().toISOString();
  // Mirror the 14-day TTL set by create-auth-challenge's PutItem so a callback
  // that upserts a row without a prior record (skipped/failed PutItem) cannot
  // create an immortal entry. if_not_exists preserves an existing TTL.
  const ttl = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
  const values: Record<string, { S: string } | { N: string }> = {
    ':status': { S: input.messageStatus },
    ':updatedAt': { S: now },
    ':ttl': { N: String(ttl) },
  };
  const names: Record<string, string> = {
    '#status': 'messageStatus',
    '#updatedAt': 'updatedAt',
    '#ttl': 'ttl',
  };
  const assignments = ['#status = :status', '#updatedAt = :updatedAt', '#ttl = if_not_exists(#ttl, :ttl)'];

  if (input.errorCode) {
    values[':errorCode'] = { S: input.errorCode };
    names['#errorCode'] = 'errorCode';
    assignments.push('#errorCode = :errorCode');
  }
  if (input.errorMessage) {
    values[':errorMessage'] = { S: input.errorMessage };
    names['#errorMessage'] = 'errorMessage';
    assignments.push('#errorMessage = :errorMessage');
  }

  await dynamodb.send(new UpdateItemCommand({
    TableName: tableName,
    Key: { twilioMessageSid: { S: input.messageSid } },
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}
