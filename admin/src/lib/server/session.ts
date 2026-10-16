import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getAdminAuthConfig } from '../auth';
import { safeNextPath } from '../safe-redirect';
import { ADMIN_NEXT_HEADER, ADMIN_SESSION_COOKIE } from '../session-cookie';
import {
  buildAdminSessionFromClaims,
  isLocalPreviewAllowed,
  type AdminIdentity,
  type AdminSession,
  type AdminTokenClaims,
} from './session-claims';
import { ADMIN_SESSION_MAX_SECONDS, AdminSessionStore } from './admin-session-store';
import { recordAdminSession } from './audit/record';
import { getAdminDbPool } from './db';

/**
 * How long the browser keeps the session cookie after the session ends. The
 * server refuses the token from the moment the session expires; the cookie
 * outlives the session so that the admin's next request still presents the
 * token, and that request records the expiry. The cookie is set once, at
 * sign-in, for the longest a session can last (eight hours) plus this grace.
 */
export const ADMIN_SESSION_COOKIE_GRACE_SECONDS = 24 * 60 * 60;

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
let accessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function poolConfig() {
  const config = getAdminAuthConfig();

  if (!config.userPoolId || !config.clientId) {
    throw new Error('Admin Cognito user pool and client ID are required for session validation');
  }
  return config;
}

function getVerifier() {
  const config = poolConfig();
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'id',
    clientId: config.clientId,
  });

  return verifier;
}

// The access token's own verifier: same pool and client, tokenUse 'access'.
function getAccessVerifier() {
  const config = poolConfig();
  accessVerifier ??= CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'access',
    clientId: config.clientId,
  });

  return accessVerifier;
}

export function getAdminSessionCookieOptions(maxAge = ADMIN_SESSION_MAX_SECONDS + ADMIN_SESSION_COOKIE_GRACE_SECONDS) {
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

/** What sign-in reads from a verified access token (contract K1.2). */
export type AdminAccessToken = {
  sub: string;
  /** The pool's username for the user, for the device calls. */
  username: string;
  /** Present when the sign-in used or registered a device. */
  deviceKey?: string;
};

/** Verifies an access token of the admin pool and client. Throws when it does not verify. */
export async function verifyAdminAccessToken(accessToken: string): Promise<AdminAccessToken> {
  const payload = await getAccessVerifier().verify(accessToken) as Record<string, unknown>;
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) {
    throw new Error('Admin access token is missing subject');
  }
  const username = typeof payload.username === 'string' && payload.username.trim()
    ? payload.username.trim()
    : sub;
  const deviceKey = typeof payload.device_key === 'string' && payload.device_key.trim()
    ? payload.device_key.trim()
    : undefined;
  return { sub, username, ...(deviceKey ? { deviceKey } : {}) };
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

/**
 * Contract K1.3 (sprint 28; BE-1 owns the body): the resolved session plus
 * whether a session cookie was sent, so callers can tell an ended session
 * ("expired") from no session at all.
 */
export async function getAdminSessionState(): Promise<{ session?: AdminSession; hadCookie: boolean }> {
  const cookieStore = await cookies();
  const hadCookie = Boolean(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
  const session = await getCurrentAdminSession();
  return { session, hadCookie };
}

/** Contract K1.3: the 401 an admin API route returns when there is no session. */
export function adminApiUnauthorized(state: { session?: AdminSession; hadCookie: boolean }): Response {
  return Response.json({ error: state.hadCookie ? 'session_expired' : 'unauthorized' }, { status: 401 });
}

/**
 * The signed-in admin, or a redirect to sign-in (contract K1.3):
 * `/login?next=<path+query>&reason=expired` when a session cookie was sent but
 * its session has ended (idle hour, eight-hour day, sign-out elsewhere,
 * revoked, or the admin deactivated), and `/login?next=<path+query>` when
 * there was no cookie. The path and query come from the proxy's
 * x-admin-next header, through safeNextPath.
 */
export async function requireAdminSession(): Promise<AdminSession> {
  const state = await getAdminSessionState();
  if (state.session) {
    return state.session;
  }

  const next = safeNextPath((await headers()).get(ADMIN_NEXT_HEADER));
  const params = new URLSearchParams({ next });
  if (state.hadCookie) {
    params.set('reason', 'expired');
  }
  redirect(`/login?${params.toString()}`);
}
