// A one-slot registry that lets the transport layer (`lib/api.ts`) ask the
// React auth layer (`contexts/AuthContext.tsx`) for a fresh token, without
// either importing the other. `lib/api.ts` must stay React-free: it runs from
// plain modules, tests and non-component code paths.
//
// `AuthProvider` registers on mount and unregisters on unmount. When nothing is
// registered, apiFetch simply cannot refresh -- a mid-session 401 then falls
// straight through to "session expired", which is the pre-bridge behaviour.

/**
 * What a renewal found out (contract K4.1). Three answers, because the
 * transport does three different things with them:
 *  - `ok`: the NEW id token; the request is replayed with it.
 *  - `refused`: the session is really gone (the refresh token was refused, or
 *    none is stored); the transport ends it.
 *  - `unavailable`: the refresh endpoint answered, but not with a verdict on
 *    the token (a 5xx, an unreadable body). The session is kept.
 */
export type RefreshOutcome =
  | { status: 'ok'; token: string }
  | { status: 'refused' }
  | { status: 'unavailable' };

export type AuthBridge = {
  /**
   * Renews the id token. Resolves a `RefreshOutcome`, and REJECTS only when
   * the renewal request got no answer at all (offline, timeout) -- which,
   * like `unavailable`, says nothing about whether the session is still good.
   * Implementations must be single-flight: apiFetch calls this once per
   * request that 401s, and N concurrent requests must not produce N refreshes.
   */
  refreshIdToken(): Promise<RefreshOutcome>;
  /** Tear down local session state and send the user to the login page. */
  onSessionExpired(): void;
};

let currentBridge: AuthBridge | null = null;

export function registerAuthBridge(bridge: AuthBridge | null): void {
  currentBridge = bridge;
}

export function getAuthBridge(): AuthBridge | null {
  return currentBridge;
}
