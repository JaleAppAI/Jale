import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getAdminAuthConfig } from '../auth';
import { ADMIN_SESSION_COOKIE } from '../session-cookie';
import {
  buildAdminSessionFromClaims,
  isLocalPreviewAllowed,
  type AdminIdentity,
  type AdminSession,
  type AdminTokenClaims,
} from './session-claims';
import { ADMIN_SESSION_TTL_SECONDS, AdminSessionStore } from './admin-session-store';
import { recordAdminSession } from './audit/record';
import { getAdminDbPool } from './db';

/**
 * How long the browser keeps the session cookie after the session ends. The
 * server refuses the token from the moment the session expires; the cookie
 * outlives the session so that the admin's next request still presents the
 * token, and that request records the expiry.
 */
export const ADMIN_SESSION_COOKIE_GRACE_SECONDS = 24 * 60 * 60;

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function getVerifier() {
  const config = getAdminAuthConfig();

  if (!config.userPoolId || !config.clientId) {
    throw new Error('Admin Cognito user pool and client ID are required for session validation');
  }

  verifier ??= CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'id',
    clientId: config.clientId,
  });

  return verifier;
}

export function getAdminSessionCookieOptions(maxAge = ADMIN_SESSION_TTL_SECONDS + ADMIN_SESSION_COOKIE_GRACE_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // 'strict' for an admin-only panel: the session cookie is never sent on
    // cross-site requests (including top-level link navigations), closing the
    // door on cross-site GET-triggered state changes.
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  };
}

export async function verifyAdminIdToken(idToken: string): Promise<AdminIdentity> {
  const payload = await getVerifier().verify(idToken);
  return buildAdminSessionFromClaims(payload as AdminTokenClaims);
}

export async function getCurrentAdminSession(): Promise<AdminSession | undefined> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;

  if (rawToken) {
    try {
      const pool = await getAdminDbPool();
      const active = await new AdminSessionStore(pool, {
        onExpired: (expired) => recordAdminSession('expired', expired),
      }).resolve(rawToken);
      // A fresh request id per resolved session: every event this request
      // records carries it.
      return active ? { ...active, requestId: randomUUID() } : undefined;
    } catch {
      return undefined;
    }
  }

  if (isLocalPreviewAllowed(
    process.env.NODE_ENV,
    process.env.ADMIN_PREVIEW_ROLE,
    process.env.ADMIN_ALLOW_LOCAL_PREVIEW,
  )) {
    // No session row and no ids: the audit helpers never record for it.
    return {
      preview: true,
      sub: 'local-preview-admin',
      email: 'local-preview@jaleapp.ai',
      role: process.env.ADMIN_PREVIEW_ROLE as AdminSession['role'],
      groups: [process.env.ADMIN_PREVIEW_ROLE as string],
    };
  }

  return undefined;
}

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getCurrentAdminSession();

  if (!session) {
    redirect('/login');
  }

  return session;
}
