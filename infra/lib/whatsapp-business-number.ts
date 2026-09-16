import type { Construct } from 'constructs';

/**
 * Shared, fail-closed resolution + validation for Jale's WhatsApp business
 * number, used by both ReferralsStack (public-job-apply-intent's wa.me deep
 * link) and FrontendStack (the /whatsapp redirect route's
 * WHATSAPP_BUSINESS_NUMBER env var). Both build a wa.me/<number> URL from
 * this exact value, so they read the SAME context key / env var and fail the
 * SAME way when it is missing or malformed — an operator sets it once
 * (-c whatsappBusinessNumber=... or JALE_WHATSAPP_BUSINESS_NUMBER) and both
 * consumers pick it up.
 *
 * E.164 without a leading '+' — digits only, 8-15 of them (matches the shape
 * every known caller already uses, e.g. '15551234567'). Failing closed at
 * synth here, rather than only at the frontend route's runtime, closes the
 * gap for public-job-apply-intent.ts too: that Lambda interpolates the value
 * into a wa.me URL with no runtime validation of its own.
 */
const WHATSAPP_BUSINESS_NUMBER_PATTERN = /^\d{8,15}$/;

export function resolveWhatsappBusinessNumber(scope: Construct, sourceName: string): string {
  const raw = scope.node.tryGetContext('whatsappBusinessNumber')
    ?? process.env.JALE_WHATSAPP_BUSINESS_NUMBER;
  if (!raw) {
    throw new Error(
      `${sourceName} requires whatsappBusinessNumber context (or JALE_WHATSAPP_BUSINESS_NUMBER env var) — `
      + 'pass -c whatsappBusinessNumber=15551234567 (E.164, no leading +)',
    );
  }
  if (!WHATSAPP_BUSINESS_NUMBER_PATTERN.test(raw)) {
    throw new Error(
      `${sourceName}'s whatsappBusinessNumber must be E.164 digits only, no leading + (8-15 digits) — got an invalid value`,
    );
  }
  return raw;
}
