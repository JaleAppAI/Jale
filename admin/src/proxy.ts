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

// SECURITY BOUNDARY NOTE: this proxy (Next 16's rename of the middleware
// convention) is a UX redirect layer ONLY. It checks cookie *presence*, not JWT
// validity. Next 16 runs the proxy on Node rather than the Edge runtime, so the
// original reason for the split -- Edge could not run the Cognito verifier
// cheaply -- no longer applies, but the design decision stands on its own: the
// real auth/authz boundary is server-side, and every data-loading page and every
// server action MUST call requireAdminSession() (which verifies the Cognito JWT)
// before reading or mutating. Keeping verification in one place, next to the
// data access it guards, is what makes it auditable. Do NOT add a page that
// relies on this proxy for protection.
export function proxy(request: NextRequest) {
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
