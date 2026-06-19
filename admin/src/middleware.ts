import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';
import { safeNextPath } from '@/lib/safe-redirect';
import { isLocalPreviewAllowed } from '@/lib/server/session-claims';

const PUBLIC_PREFIXES = [
  '/login',
  '/api/session',
  '/_next',
  '/favicon.ico',
];

// SECURITY BOUNDARY NOTE: this middleware is a UX redirect layer ONLY. It checks
// cookie *presence*, not JWT validity (Edge runtime can't run the full verifier
// cheaply). The real auth/authz boundary is server-side: every data-loading page
// and every server action MUST call requireAdminSession() (which verifies the
// Cognito JWT) before reading or mutating. Do NOT add a page that relies on this
// middleware for protection.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
  const hasLocalPreviewRole = isLocalPreviewAllowed(
    process.env.NODE_ENV,
    process.env.ADMIN_PREVIEW_ROLE,
    process.env.ADMIN_ALLOW_LOCAL_PREVIEW,
  );

  if (!hasSessionCookie && !hasLocalPreviewRole) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', safeNextPath(pathname));
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!.*\\..*).*)'],
};
