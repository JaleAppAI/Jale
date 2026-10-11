// GET /app -- the worker web link, for flyers, QR codes and chats. It sends a
// worker straight to the web app's sign-up, the way /whatsapp sends them
// straight to WhatsApp. Top-level (not under [locale]), like whatsapp/route.ts,
// so it serves locale-middleware-free (see proxy.ts's PUBLIC_PATTERNS bypass)
// and can default to Spanish instead of the site's English.
//
// Only a valid job id and a valid share code pass through. Everything else --
// returnUrl, utm_*, `lang` itself -- is dropped. Nothing is counted here.
//
// A signed-in worker needs nothing special: the worker auth page already sends
// them on (job, then returnUrl, then /worker/home) and ignores `step`.
import { locales, type Locale } from '@/i18n/locales';
import { validateJobId } from '@/lib/referral-return';
import { normalizeShareCode } from '@/lib/share-code';

export const dynamic = 'force-dynamic';

// next-intl's default locale cookie: the language a visitor chose on the site.
const LOCALE_COOKIE = 'NEXT_LOCALE';

// Deliberately not the site default (`en` in proxy.ts): this link is Spanish
// unless the visitor asks otherwise.
const DEFAULT_LOCALE: Locale = 'es';

/** Strict: exactly `en` or `es`, no case folding. */
function asLocale(value: string | null): Locale | null {
  return locales.find((locale) => locale === value) ?? null;
}

/**
 * Reads one cookie off the raw Cookie header. At runtime the request is a
 * NextRequest with `request.cookies`, but the tests drive this handler with a
 * plain Request; both carry the header, so this works for either.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  // ?lang= first, then the visitor's earlier choice on the site, then Spanish.
  const locale =
    asLocale(searchParams.get('lang'))
    ?? asLocale(readCookie(request, LOCALE_COOKIE))
    ?? DEFAULT_LOCALE;

  const target = new URLSearchParams({ step: 'signup' });
  const jobId = validateJobId(searchParams.get('job'));
  if (jobId) target.set('job', jobId);
  // `share` first, then `r`, the alias public share URLs use. The first that
  // normalises to a valid code wins, so an empty or garbled `share` cannot
  // cancel a good `r`.
  const shareCode =
    normalizeShareCode(searchParams.get('share')) ?? normalizeShareCode(searchParams.get('r'));
  if (shareCode) target.set('share', shareCode);

  // Relative on purpose. Behind CloudFront this origin sees the Lambda
  // Function URL host, not jaleapp.ai, so a Location built from request.url
  // would send visitors to the raw Lambda URL. NextResponse.redirect refuses a
  // relative URL, hence the plain Response, as in whatsapp/route.ts.
  return new Response(null, {
    status: 307,
    headers: {
      Location: `/${locale}/auth/worker?${target.toString()}`,
      'Cache-Control': 'no-store',
    },
  });
}
