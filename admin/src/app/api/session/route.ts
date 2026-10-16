import { NextResponse } from 'next/server';
import {
  getAdminSessionCookieOptions,
  verifyAdminAccessToken,
  verifyAdminIdToken,
} from '@/lib/server/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/session-cookie';
import { AdminSessionStore, type ActiveAdminSession } from '@/lib/server/admin-session-store';
import { recordAdminSession } from '@/lib/server/audit/record';
import { getAdminDirectory } from '@/lib/server/cognito-admin';
import { getAdminDbPool } from '@/lib/server/db';
import { applyDeviceTrust } from '@/lib/server/device-trust';
import { cookies } from 'next/headers';

// Sign-in (contract K1.2): { idToken, accessToken, trustDevice }. Both tokens
// are verified (same pool, client and subject); the access token's device key
// decides trusted-browser sign-in through device-trust.ts.
export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);
  const idToken = typeof body?.idToken === 'string' ? body.idToken.trim() : '';
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
  const trustDevice = body?.trustDevice === true;

  if (!idToken) {
    return NextResponse.json({ error: 'id_token_required' }, { status: 400 });
  }
  if (!accessToken) {
    return NextResponse.json({ error: 'access_token_required' }, { status: 400 });
  }

  let created: { rawToken: string };
  let session: ActiveAdminSession | undefined;
  let trustedDevice = false;
  try {
    const identity = await verifyAdminIdToken(idToken);
    const access = await verifyAdminAccessToken(accessToken);
    if (access.sub !== identity.sub) {
      throw new Error('The ID and access tokens name different users');
    }
    const pool = await getAdminDbPool();
    const store = new AdminSessionStore(pool);
    const admin = await store.findActiveAdmin(identity.sub);
    if (!admin) {
      throw new Error('Admin account is inactive or not provisioned');
    }

    // A Cognito or database error here fails the sign-in closed (below).
    const trust = await applyDeviceTrust({
      db: pool,
      directory: getAdminDirectory(),
      adminUserId: admin.id,
      username: access.username,
      deviceKey: access.deviceKey,
      trustDevice,
    });
    if (trust.outcome === 'trust_expired') {
      // The browser's trust has passed 7 days: the device is no longer
      // remembered, and the admin signs in again with a code.
      await recordAdminSession('sign_in_rejected', { adminUserId: admin.id, role: admin.role });
      return NextResponse.json({ error: 'device_trust_expired' }, { status: 401 });
    }
    trustedDevice = trust.outcome === 'trusted_device';

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

  await recordAdminSession('signed_in', session, trustedDevice ? { fieldNames: ['trusted_device'] } : {});
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
