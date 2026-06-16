import { NextResponse } from 'next/server';
import {
  getAdminSessionCookieOptions,
  verifyAdminIdToken,
} from '@/lib/server/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';
import { AdminSessionStore } from '@/lib/server/admin-session-store';
import { getAdminDbPool } from '@/lib/server/db';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);
  const idToken = typeof body?.idToken === 'string' ? body.idToken.trim() : '';

  if (!idToken) {
    return NextResponse.json({ error: 'id_token_required' }, { status: 400 });
  }

  try {
    const identity = await verifyAdminIdToken(idToken);
    const pool = await getAdminDbPool();
    const created = await new AdminSessionStore(pool).create(identity, {
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    const session = await new AdminSessionStore(pool).resolve(created.rawToken);
    if (!session) {
      throw new Error('Created admin session could not be resolved');
    }
    const response = NextResponse.json({
      ok: true,
      role: session.role,
      email: session.email,
    });

    response.cookies.set(ADMIN_SESSION_COOKIE, created.rawToken, getAdminSessionCookieOptions());
    return response;
  } catch {
    return NextResponse.json({ error: 'invalid_admin_token' }, { status: 401 });
  }
}

export async function DELETE() {
  const rawToken = cookies().get(ADMIN_SESSION_COOKIE)?.value;
  if (rawToken) {
    try {
      const pool = await getAdminDbPool();
      await new AdminSessionStore(pool).revoke(rawToken, 'user_logout');
    } catch (error) {
      console.error('Failed to revoke admin session during logout', error);
    }
  }

  const response = NextResponse.json({ ok: true });

  response.cookies.set(ADMIN_SESSION_COOKIE, '', getAdminSessionCookieOptions(0));
  return response;
}
