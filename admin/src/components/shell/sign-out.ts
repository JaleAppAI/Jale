import { CognitoUserPool } from 'amazon-cognito-identity-js';
import type { AdminClientAuthConfig } from '@/lib/auth';
import { adminFetchJson } from '@/lib/admin-fetch';

/**
 * Signs the admin out (K1.3): end the server session, then the Cognito SDK's
 * local session, then go to /login. Any step may fail (offline, session
 * already ended, SDK error) and the browser still lands on /login, once.
 */
export async function signOutAdmin(authConfig: AdminClientAuthConfig): Promise<void> {
  // Its 401 means "already signed out", not "sign in again". adminFetchJson
  // never throws, so this await cannot skip the steps below.
  await adminFetchJson('/api/session', { method: 'DELETE', redirectOn401: false });
  try {
    if (authConfig.userPoolId && authConfig.clientId) {
      new CognitoUserPool({ UserPoolId: authConfig.userPoolId, ClientId: authConfig.clientId }).getCurrentUser()?.signOut();
    }
  } catch {
    // The SDK keeps only a local session; /login starts a fresh sign-in.
  }
  window.location.assign('/login');
}
