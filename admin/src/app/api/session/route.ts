import { NextResponse } from 'next/server';
import {
  getAdminSessionCookieOptions,
  verifyAdminIdToken,
} from '@/lib/server/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);
  const idToken = typeof body?.idToken === 'string' ? body.idToken.trim() : '';

  if (!idToken) {
    return NextResponse.json({ error: 'id_token_required' }, { status: 400 });
  }

  try {
    const session = await verifyAdminIdToken(idToken);
    const response = NextResponse.json({
      ok: true,
      role: session.role,
      email: session.email,
    });

    response.cookies.set(ADMIN_SESSION_COOKIE, idToken, getAdminSessionCookieOptions());
    return response;
  } catch {
    return NextResponse.json({ error: 'invalid_admin_token' }, { status: 401 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(ADMIN_SESSION_COOKIE, '', getAdminSessionCookieOptions(0));
  return response;
}
