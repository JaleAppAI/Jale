import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  validateTwilioSignature,
  parseFormBody,
  reconstructWebhookUrl,
  type TwilioSecret,
} from './lib/twilio';

// Module-level clients — reused across warm invocations
const sqs = new SQSClient({});
const secretsManager = new SecretsManagerClient({});

// In-memory cache for the Twilio auth token (5-min TTL, matches lambda/lib/db.ts pattern).
// On cold start the cache is empty → first request pays a SecretsManager call.
let cachedSecret: TwilioSecret | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getTwilioSecret(): Promise<TwilioSecret> {
  const now = Date.now();
  if (cachedSecret && now < cacheExpiresAt) return cachedSecret;

  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN env var not set');

  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!result.SecretString) throw new Error('TWILIO secret has no SecretString');

  cachedSecret = JSON.parse(result.SecretString) as TwilioSecret;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedSecret;
}

/**
 * WhatsApp webhook receiver (Twilio).
 *
 * 1. Reconstructs the exact public URL Twilio POSTed to (from event.requestContext)
 * 2. Parses the form-encoded POST body
 * 3. Validates X-Twilio-Signature via HMAC-SHA1 using Twilio auth token
 * 4. On valid: pushes raw body to SQS for async processing, returns 200
 * 5. On invalid: returns 403 without queuing
 *
 * The webhook does NO DB access and NO Twilio API calls. It's a pure gateway
 * between Twilio and the SQS-driven processor.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const encodedBody = event.body ?? '';
    const rawBody = event.isBase64Encoded
      ? Buffer.from(encodedBody, 'base64').toString('utf8')
      : encodedBody;
    if (!rawBody) {
      return { statusCode: 400, body: 'empty body' };
    }

    // 1. Reconstruct the URL Twilio POSTed to. Must match byte-exact.
    const fullUrl = reconstructWebhookUrl(
      event.requestContext as any,
      event.headers as Record<string, string | undefined>,
    );

    // 2. Parse the form body
    const params = parseFormBody(rawBody);

    // 3. Validate the signature
    const signature =
      event.headers['X-Twilio-Signature'] ??
      event.headers['x-twilio-signature'];
    const { authToken } = await getTwilioSecret();
    const valid = validateTwilioSignature(fullUrl, params, signature, authToken);

    if (!valid) {
      console.warn('[webhook] invalid signature', {
        hasSignature: !!signature,
        messageSid: params.MessageSid,
      });
      return { statusCode: 403, body: 'invalid signature' };
    }

    if (!params.From || !params.MessageSid) {
      console.warn('[webhook] malformed signed webhook body', {
        hasFrom: !!params.From,
        hasMessageSid: !!params.MessageSid,
      });
      return { statusCode: 400, body: 'malformed body' };
    }

    // 4. Push to SQS for async processing. Store raw body to preserve form
    //    encoding for the processor (it re-parses for consistency).
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) throw new Error('SQS_QUEUE_URL env var not set');

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: rawBody,
      }),
    );

    console.log('[webhook] queued', {
      messageSid: params.MessageSid,
      hasFrom: true,
    });

    // 5. Return 200 — Twilio expects a 2xx response within a few seconds,
    //    or it will retry. Returning plain text is fine.
    return { statusCode: 200, body: 'queued' };
  } catch (err: unknown) {
    console.error('[webhook] handler error:', err);
    return {
      statusCode: 500,
      body: 'internal error',
    };
  }
};
