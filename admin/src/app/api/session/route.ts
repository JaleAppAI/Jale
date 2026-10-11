import { NextResponse } from 'next/server';
import {
  getAdminSessionCookieOptions,
  verifyAdminIdToken,
} from '@/lib/server/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';
import { AdminSessionStore, type ActiveAdminSession } from '@/lib/server/admin-session-store';
import { recordAdminSession } from '@/lib/server/audit/record';
import { getAdminDbPool } from '@/lib/server/db';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);
  const idToken = typeof body?.idToken === 'string' ? body.idToken.trim() : '';

  if (!idToken) {
    return NextResponse.json({ error: 'id_token_required' }, { status: 400 });
  }

  let created: { rawToken: string };
  let session: ActiveAdminSession | undefined;
  try {
    const identity = await verifyAdminIdToken(idToken);
    const store = new AdminSessionStore(await getAdminDbPool());
    created = await store.create(identity, {
      userAgent: request.headers.get('user-agent') ?? undefined,
    });
    session = await store.resolve(created.rawToken);
    if (!session) {
      throw new Error('Created admin session could not be resolved');
    }
  } catch {
    // A token that fails verification, or that maps to no active admin, is
    // recorded without an actor: the verified subject is never stored.
    await recordAdminSession('sign_in_rejected', null);
    return NextResponse.json({ error: 'invalid_admin_token' }, { status: 401 });
  }

  await recordAdminSession('signed_in', session);
  const response = NextResponse.json({
    ok: true,
    role: session.role,
    email: session.email,
  });

  response.cookies.set(ADMIN_SESSION_COOKIE, created.rawToken, getAdminSessionCookieOptions());
  return response;
}

export async function DELETE() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (rawToken) {
    try {
      const pool = await getAdminDbPool();
      const ended = await new AdminSessionStore(pool).revoke(rawToken, 'user_logout');
      // A live session signs out. One already past its expiry ended by
      // expiring and is recorded as expired. A session that had already
      // ended records nothing, so a repeated sign-out records nothing.
      if (ended) {
        await recordAdminSession(ended.live ? 'signed_out' : 'expired', ended);
      }
    } catch (error) {
      console.error('Failed to revoke admin session during logout', error);
    }
  }

  const response = NextResponse.json({ ok: true });

  response.cookies.set(ADMIN_SESSION_COOKIE, '', getAdminSessionCookieOptions(0));
  return response;
}
