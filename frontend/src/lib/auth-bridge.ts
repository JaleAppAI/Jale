// A one-slot registry that lets the transport layer (`lib/api.ts`) ask the
// React auth layer (`contexts/AuthContext.tsx`) for a fresh token, without
// either importing the other. `lib/api.ts` must stay React-free: it runs from
// plain modules, tests and non-component code paths.
//
// `AuthProvider` registers on mount and unregisters on unmount. When nothing is
// registered, apiFetch simply cannot refresh -- a mid-session 401 then falls
// straight through to "session expired", which is the pre-bridge behaviour.

export type AuthBridge = {
  /**
   * Resolves the NEW id token, or null when the session could not be renewed.
   * Implementations must be single-flight: apiFetch calls this once per
   * request that 401s, and N concurrent requests must not produce N refreshes.
   */
  refreshIdToken(): Promise<string | null>;
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
