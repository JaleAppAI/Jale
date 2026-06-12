import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getAdminAuthConfig } from '../auth';
import { ADMIN_SESSION_COOKIE } from '../session-cookie';
import {
  buildAdminSessionFromClaims,
  isLocalPreviewAllowed,
  type AdminSession,
  type AdminTokenClaims,
} from './session-claims';

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

export function getAdminSessionCookieOptions(maxAge = 60 * 60) {
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

export async function verifyAdminIdToken(idToken: string): Promise<AdminSession> {
  const payload = await getVerifier().verify(idToken);
  return buildAdminSessionFromClaims(payload as AdminTokenClaims);
}

export async function getCurrentAdminSession(): Promise<AdminSession | undefined> {
  const idToken = cookies().get(ADMIN_SESSION_COOKIE)?.value;

  if (idToken) {
    try {
      return await verifyAdminIdToken(idToken);
    } catch {
      return undefined;
    }
  }

  if (isLocalPreviewAllowed(process.env.NODE_ENV, process.env.ADMIN_PREVIEW_ROLE)) {
    return {
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
