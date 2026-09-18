// GET /whatsapp -- a clean, shareable link that opens WhatsApp to Jale's
// business number with prefilled text. Top-level (not under [locale]), like
// feed.xml/route.ts and sms-opt-in/route.ts, so it serves unauthenticated and
// locale-middleware-free (see proxy.ts's PUBLIC_PATTERNS bypass).
//
// The business number is NEVER hardcoded here or anywhere else in this repo
// -- it comes from WHATSAPP_BUSINESS_NUMBER, the same runtime env var CDK's
// FrontendStack threads in from the whatsappBusinessNumber context/env
// (infra/lib/whatsapp-business-number.ts), which is the same value
// ReferralsStack's public-job-apply-intent Lambda uses to build its own
// wa.me link.
export const dynamic = 'force-dynamic';

// E.164 without a leading '+' -- digits only, 8-15 of them. Matches the shape
// every known caller of WHATSAPP_BUSINESS_NUMBER already uses (e.g.
// '15551234567'). A value that fails this MUST NOT reach a wa.me URL: a
// malformed number there is a silently broken deep link with no error
// anywhere downstream.
const WHATSAPP_NUMBER_PATTERN = /^\d{8,15}$/;

export async function GET(request: Request): Promise<Response> {
  const number = process.env.WHATSAPP_BUSINESS_NUMBER;
  const isValid = typeof number === 'string' && WHATSAPP_NUMBER_PATTERN.test(number);

  if (!isValid) {
    // Never log the value itself -- only whether it was present, since a
    // malformed value could still be sensitive-shaped.
    console.error('whatsapp-route: WHATSAPP_BUSINESS_NUMBER is missing or malformed', {
      present: typeof number === 'string' && number.length > 0,
    });
    return new Response('WhatsApp link is temporarily unavailable.', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Prefill the same opener a worker types by hand: a greeting. Both words
  // are in the bot's GREETING_WORDS / detectCommandLanguage lists
  // (infra/lambda/whatsapp/lib/flows.ts), so a brand-new number gets the
  // language invite and a returning worker gets the idle menu in their
  // language. Luis's ruling 2026-09-18: never a command word like "Jobs".
  const { searchParams } = new URL(request.url);
  const text = searchParams.get('lang') === 'en' ? 'Hello' : 'Hola';
  const location = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;

  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
}
