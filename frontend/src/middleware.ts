import createMiddleware from 'next-intl/middleware';
import { locales } from './i18n/locales';
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATTERNS = [
  /^\/[a-z]{2}\/upload\//,
  /^\/terms\/?$/,
  /^\/privacypolicy\/?$/,
  /^\/legal\/terms(?:\/[^/]+)?\/?$/,
  /^\/legal\/privacy(?:\/[^/]+)?\/?$/,
];

const intlMiddleware = createMiddleware({ locales, defaultLocale: 'en' });

export default function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATTERNS.some((p) => p.test(pathname))) {
    if (
      pathname === '/terms'
      || pathname === '/privacypolicy'
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
