import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_NEXT_HEADER, ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';
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
//
// ADMIN_NEXT_HEADER (`x-admin-next`, contract K1.3): the proxy hands the page
// the requested path and query, through safeNextPath, so requireAdminSession()
// can send an admin whose session has ended back to the same page after
// sign-in. The proxy always sets it itself; a value the client sent never
// reaches the page.
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const next = safeNextPath(pathname + search);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(ADMIN_NEXT_HEADER, next);
  const passOn = () => NextResponse.next({ request: { headers: requestHeaders } });

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return passOn();
  }

  const hasSessionCookie = Boolean(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
  const hasLocalPreviewRole = isLocalPreviewAllowed(
    process.env.NODE_ENV,
    process.env.ADMIN_PREVIEW_ROLE,
    process.env.ADMIN_ALLOW_LOCAL_PREVIEW,
  );

  if (!hasSessionCookie && !hasLocalPreviewRole) {
    // The query travels inside `next` only; nothing else is copied over.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('next', next);
    return NextResponse.redirect(loginUrl);
  }

  return passOn();
}

export const config = {
  matcher: ['/((?!.*\\..*).*)'],
};
