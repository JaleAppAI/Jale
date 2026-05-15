/**
 * Twilio utility module — signature validation and message sending.
 *
 * We intentionally do NOT depend on the `twilio` npm package. Reasons:
 *   1. Smaller bundle (the Twilio SDK is ~1.5 MB; we only need HMAC + HTTP).
 *   2. No pg-native / binary deps to wrangle through esbuild.
 *   3. HMAC-SHA1 is trivial in Node's built-in `crypto` module.
 *
 * Signature algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 *   data = fullUrl + concat(sortedKeys.map(k => k + params[k]))
 *   signature = base64(hmac_sha1(authToken, data))
 *   Compare against X-Twilio-Signature header.
 *
 * The fullUrl must be EXACTLY what Twilio POSTed to, including scheme, host,
 * stage, and path. We reconstruct it at runtime from event.requestContext in
 * the webhook handler — see webhook.ts for why.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validates a Twilio webhook signature.
 *
 * @param fullUrl  The exact public URL Twilio POSTed to (reconstructed from event.requestContext)
 * @param params   The POST body parameters (parsed form-encoded data, each key → value)
 * @param signature The value of the X-Twilio-Signature header
 * @param authToken Twilio account auth token (from Secrets Manager)
 * @returns true if the signature matches, false otherwise
 */
export function validateTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signature: string | undefined,
  authToken: string,
): boolean {
  if (!signature) return false;

  // Build the data string: URL + sorted (key + value) concatenations.
  // Twilio sorts keys using plain string comparison.
  const sortedKeys = Object.keys(params).sort();
  const data =
    fullUrl +
    sortedKeys.map((k) => `${k}${params[k]}`).join('');

  const expected = createHmac('sha1', authToken).update(data).digest('base64');

  // Use timingSafeEqual to avoid leaking information about partial matches.
  // Note: both buffers must be the same length; mismatched length → false.
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signature);
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Parses a URL-encoded form body into a Record<string, string>.
 * Used by the webhook to decode the Twilio POST body before signature validation
 * (signature is computed over the parsed form data, not the raw body string).
 */
export function parseFormBody(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

/**
 * Reconstructs the full public URL from an API Gateway proxy event.
 *
 * Twilio's HMAC is computed over the EXACT URL it POSTed to. We reconstruct
 * this at runtime instead of storing it as a Lambda env var (see whatsapp-stack.ts
 * for why — avoids a cross-stack dependency cycle).
 *
 * Prefer X-Forwarded-Host when present (custom domain scenario), else fall
 * back to the API Gateway's default domainName.
 */
export function reconstructWebhookUrl(requestContext: {
  domainName?: string;
  stage?: string;
  path?: string;
}, headers: Record<string, string | undefined>): string {
  // Header case varies by API Gateway integration; normalize.
  const forwardedHost =
    headers['X-Forwarded-Host'] ??
    headers['x-forwarded-host'];
  const host = forwardedHost ?? requestContext.domainName ?? '';
  // requestContext.path already includes the stage prefix (e.g. "/dev/whatsapp/webhook")
  const path = requestContext.path ?? '';
  return `https://${host}${path}`;
}

export interface TwilioSecret {
  accountSid: string;
  authToken: string;
  // Twilio Messaging Service SID (starts with "MG..."). The service
  // contains the WhatsApp sender(s) registered in the Twilio Console and
  // handles sender selection automatically — we don't pass a raw From.
  messagingServiceSid: string;
  templates?: {
    job_alert_es?: string;
    job_alert_en?: string;
    profile_reminder_es?: string;
    profile_reminder_en?: string;
    welcome_es?: string;
    welcome_en?: string;
    onboarding_legal_es?: string;
    onboarding_legal_en?: string;
    onboarding_trade_es?: string;
    onboarding_trade_en?: string;
    onboarding_experience_es?: string;
    onboarding_experience_en?: string;
    onboarding_transportation_es?: string;
    onboarding_transportation_en?: string;
    onboarding_availability_es?: string;
    onboarding_availability_en?: string;
    onboarding_photo_skip_es?: string;
    onboarding_photo_skip_en?: string;
    onboarding_photo_type_es?: string;
    onboarding_photo_type_en?: string;
    onboarding_voice_choice_es?: string;
    onboarding_voice_choice_en?: string;
    trust_choice_es?: string;
    trust_choice_en?: string;
  };
}
