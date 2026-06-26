import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  parseFormBody,
  reconstructWebhookUrl,
  validateTwilioSignature,
} from '../whatsapp/lib/twilio';

interface OtpTwilioSecret {
  accountSid: string;
  authToken: string;
}

const dynamodb = new DynamoDBClient({});
const secretsManager = new SecretsManagerClient({});

let cachedSecret: OtpTwilioSecret | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body ?? '';
  const params = parseFormBody(rawBody);
  const secret = await getOtpTwilioSecret();
  const fullUrl = reconstructCallbackUrl(event);
  const signature = event.headers['X-Twilio-Signature'] ?? event.headers['x-twilio-signature'];

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

async function getOtpTwilioSecret(): Promise<OtpTwilioSecret> {
  const now = Date.now();
  if (cachedSecret && now - cachedAt < CACHE_TTL_MS) {
    return cachedSecret;
  }
  const secretId = process.env.TWILIO_SECRET_ARN;
  if (!secretId) {
    throw new Error('Missing TWILIO_SECRET_ARN');
  }
  const resp = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!resp.SecretString) {
    throw new Error('TWILIO_SECRET_ARN secret has no SecretString');
  }
  const parsed = JSON.parse(resp.SecretString) as Partial<OtpTwilioSecret>;
  if (!parsed.accountSid || !parsed.authToken) {
    throw new Error('OTP Twilio secret missing accountSid/authToken');
  }
  cachedSecret = parsed as OtpTwilioSecret;
  cachedAt = now;
  return cachedSecret;
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
  const values: Record<string, { S: string }> = {
    ':status': { S: input.messageStatus },
    ':updatedAt': { S: now },
  };
  const names: Record<string, string> = {
    '#status': 'messageStatus',
    '#updatedAt': 'updatedAt',
  };
  const assignments = ['#status = :status', '#updatedAt = :updatedAt'];

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

function emitOtpMetric(metricName: string, dimensions: Record<string, string> = {}): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Jale/OTP',
        Dimensions: [Object.keys(dimensions)],
        Metrics: [{ Name: metricName, Unit: 'Count' }],
      }],
    },
    ...dimensions,
    [metricName]: 1,
  }));
}

export function _clearSecretCacheForTests(): void {
  cachedSecret = null;
  cachedAt = 0;
}
