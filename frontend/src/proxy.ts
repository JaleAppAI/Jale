import createMiddleware from 'next-intl/middleware';
import { locales } from './i18n/locales';
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATTERNS = [
  /^\/[a-z]{2}\/upload\//,
  /^\/[a-z]{2}\/j\//,
  /^\/terms\/?$/,
  /^\/privacypolicy\/?$/,
  /^\/sms-opt-in\/?$/,
  /^\/legal\/terms(?:\/[^/]+)?\/?$/,
  /^\/legal\/privacy(?:\/[^/]+)?\/?$/,
];

// next-intl's own helper is still called `createMiddleware`; only Next's
// entrypoint was renamed, so this stays as it is.
const intlMiddleware = createMiddleware({ locales, defaultLocale: 'en' });

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATTERNS.some((p) => p.test(pathname))) {
    if (
      pathname === '/terms'
      || pathname === '/privacypolicy'
      || pathname === '/sms-opt-in'
      || pathname.startsWith('/legal/terms')
      || pathname.startsWith('/legal/privacy')
    ) {
      return NextResponse.next();
    }
    return intlMiddleware(request);
  }
  return intlMiddleware(request);
}

export const config = { matcher: ['/((?!api|_next|.*\\..*).*)'] };
