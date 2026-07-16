import type { Construct } from 'constructs';

/**
 * Shared, fail-closed resolution + normalization for the Twilio WhatsApp
 * delivery-status callback URL used by both ApiStack (employer-conversations
 * Lambdas that send WhatsApp messages) and WhatsAppStack (webhook/processor/
 * job-alert/outbox/status-callback Lambdas).
 *
 * This is a required value in every environment that sends WhatsApp
 * messages: Twilio signs its delivery-status callback against the exact
 * configured URL, and `sendTwilioWhatsAppMessage` always sets
 * `StatusCallback` on outbound sends. Silently omitting it (as opposed to
 * failing synth) would produce WhatsApp sends with no delivery callback and
 * no loud failure — exactly the fail-open behavior review flagged.
 */
export function resolveWhatsappStatusCallbackUrl(scope: Construct): string {
  const raw = scope.node.tryGetContext('whatsappStatusCallbackUrl')
    ?? process.env.JALE_WHATSAPP_STATUS_CALLBACK_URL;
  if (!raw) {
    throw new Error(
      'whatsappStatusCallbackUrl context (or JALE_WHATSAPP_STATUS_CALLBACK_URL env var) is required — '
      + 'pass -c whatsappStatusCallbackUrl=https://<api-domain>/whatsapp/status-callback',
    );
  }
  return normalizeWhatsappStatusCallbackUrl(raw);
}

export function normalizeWhatsappStatusCallbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('whatsappStatusCallbackUrl must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith('/whatsapp/status-callback')
  ) {
    throw new Error('whatsappStatusCallbackUrl must be an HTTPS /whatsapp/status-callback URL');
  }
  return url.toString();
}
