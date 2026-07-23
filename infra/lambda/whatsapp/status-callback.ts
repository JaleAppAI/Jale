import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { isTwilioMessageSid, parseFormBody, validateTwilioSignature } from './lib/twilio';
import { getTwilioSecret, requireTwilioStatusCallbackUrl } from './lib/twilio-secret';

const MAX_BODY_BYTES = 16 * 1024;
const STATUS_RE = /^(queued|accepted|sent|delivered|read|undelivered|failed)$/;
const ERROR_CODE_RE = /^[0-9]{1,10}$/;

function response(statusCode: 200 | 400 | 403 | 503, body: string): APIGatewayProxyResult {
  return { statusCode, headers: { 'Content-Type': 'text/plain' }, body };
}

function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const pair = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return pair?.[1] ?? undefined;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const encodedBody = event.body ?? '';
  let rawBody: string;
  try {
    rawBody = event.isBase64Encoded
      ? Buffer.from(encodedBody, 'base64').toString('utf8')
      : encodedBody;
  } catch {
    return response(400, 'malformed body');
  }
  if (!rawBody || Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return response(400, 'malformed body');
  }

  // Twilio signs the parsed form fields against the exact operator-configured
  // callback URL. Do not derive this from forwarded headers: proxies and custom
  // domains can make that differ from the URL Twilio actually signed.
  const params = parseFormBody(rawBody);
  try {
    const secret = await getTwilioSecret();
    const valid = validateTwilioSignature(
      requireTwilioStatusCallbackUrl(),
      params,
      header(event, 'x-twilio-signature'),
      secret.authToken,
    );
    if (!valid) {
      console.warn(JSON.stringify({ metric: 'WhatsAppStatusCallbackRejected' }));
      return response(403, 'invalid signature');
    }
  } catch (error) {
    console.error(JSON.stringify({
      metric: 'WhatsAppStatusCallbackError',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }));
    return response(503, 'retry');
  }

  const sid = params.MessageSid?.trim();
  const status = (params.MessageStatus ?? params.SmsStatus)?.trim().toLowerCase();
  const errorCode = params.ErrorCode?.trim() || null;
  const errorMessage = params.ErrorMessage?.trim() || null;
  if (!isTwilioMessageSid(sid)
      || !status || !STATUS_RE.test(status)
      || (errorCode !== null && !ERROR_CODE_RE.test(errorCode))
      || (errorMessage !== null && errorMessage.length > 1000)) {
    return response(400, 'malformed body');
  }

  try {
    const pool = await getDbPool();
    const result = await pool.query<{ matched: boolean; changed: boolean; source: string | null }>(
      `SELECT matched, changed, source
         FROM jale_twilio_callback.record_twilio_delivery_status($1, $2, $3, $4)`,
      [sid, status, errorCode, errorMessage],
    );
    const outcome = result.rows[0] ?? { matched: false, changed: false, source: null };
    if (!outcome.matched) {
      console.warn(JSON.stringify({ metric: 'WhatsAppStatusCallbackUnknownSid', status }));
      return response(503, 'retry');
    } else if (outcome.changed && (status === 'failed' || status === 'undelivered')) {
      console.error(JSON.stringify({ metric: 'WhatsAppDeliveryFailure', status, errorCode }));
    } else if (outcome.changed) {
      console.log(JSON.stringify({ metric: 'WhatsAppDeliveryStatus', status, source: outcome.source }));
    }
  } catch (error) {
    // Internal persistence failures are retryable. The structured log makes the
    // failure observable without exposing message or phone identifiers.
    console.error(JSON.stringify({
      metric: 'WhatsAppStatusCallbackError',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }));
    return response(503, 'retry');
  }
  return response(200, 'ok');
};
