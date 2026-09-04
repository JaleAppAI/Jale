// Where the browser keeps the signed-in session between loads.
//
// `localStorage`, NOT `sessionStorage`, and that is the entire point of this
// module. `sessionStorage` is scoped to one tab: a worker who tapped a Jale
// link inside WhatsApp got a fresh tab with an empty store and was shown a
// login screen, even with a signed-in Jale tab sitting right behind it. Every
// share link the product sends is opened that way, so the per-tab session made
// the most common entry point into the app look broken.
//
// Two constraints shape everything below.
//
// A) Nobody may be logged out by the change. A session written by the old build
//    is in `sessionStorage`, so the first read falls back to it, promotes it,
//    and only then drops the old copy — and if the promotion cannot be written,
//    the old copy STAYS, because a migration that deletes the only copy of a
//    live token is worse than not migrating at all.
//
// B) Every access is wrapped. Reading or writing web storage does not merely
//    return null in a locked-down browser (Safari private browsing, "block all
//    cookies", enterprise policy) — the property access itself throws. An
//    unguarded `localStorage.getItem` in a provider's mount effect takes the
//    whole app down for those visitors.
//
// What is stored is a REFRESH token plus which pool it belongs to, which is
// what the old code kept too: web storage is readable by anything running on
// the origin, so this is not a place for the access or id token, and the
// tradeoff (a shared session that survives a reload) is the one the product
// already made.

export type StoredUserType = 'worker' | 'employer';

export type StoredSession = {
  refreshToken: string;
  /** Null when nothing valid was stored; the caller infers it from the path. */
  userType: StoredUserType | null;
};

const REFRESH_TOKEN_KEY = 'refreshToken';
const USER_TYPE_KEY = 'userType';

/**
 * Only the two real values survive a read. Anything running on the origin can
 * write this key, and it is forwarded to the API as `userType`, so a stored
 * "admin" must come back as "no idea" rather than as itself.
 */
function parseUserType(value: string | null): StoredUserType | null {
  return value === 'worker' || value === 'employer' ? value : null;
}

/** Storage access, with the throwing browsers folded into "not there". */
function read(store: Storage | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Storage | undefined, key: string, value: string): boolean {
  try {
    store?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(store: Storage | undefined, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to do and nothing to report: the caller is clearing state it
    // cannot be sure was ever written.
  }
}

/**
 * `window` is absent during SSR and the property access itself can throw, so
 * both stores are reached through this rather than referenced directly.
 */
function storage(kind: 'local' | 'session'): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * The stored session, or null when there is none.
 *
 * Reads the shared store first, then falls back ONCE to the per-tab store left
 * behind by the pre-`localStorage` build — promoting what it finds so the next
 * tab sees it too (see note A at the top of this file).
 */
export function readSession(): StoredSession | null {
  const local = storage('local');
  const shared = read(local, REFRESH_TOKEN_KEY);
  if (shared) {
    return { refreshToken: shared, userType: parseUserType(read(local, USER_TYPE_KEY)) };
  }

  const session = storage('session');
  const perTab = read(session, REFRESH_TOKEN_KEY);
  if (!perTab) return null;

  const userType = parseUserType(read(session, USER_TYPE_KEY));
  const promoted = write(local, REFRESH_TOKEN_KEY, perTab);
  if (promoted && userType) write(local, USER_TYPE_KEY, userType);
  if (promoted) {
    // Only now: while the shared copy does not exist, the per-tab one is the
    // session.
    remove(session, REFRESH_TOKEN_KEY);
    remove(session, USER_TYPE_KEY);
  }

  return { refreshToken: perTab, userType };
}

/** Stores the session for every tab on this origin. Never throws. */
export function writeSession(session: { refreshToken: string; userType: StoredUserType }): void {
  const local = storage('local');
  if (write(local, REFRESH_TOKEN_KEY, session.refreshToken)) {
    write(local, USER_TYPE_KEY, session.userType);
  }
}

/**
 * Drops the session from BOTH stores. The per-tab keys are included because a
 * user who signs out before their old session was ever promoted would
 * otherwise leave a token behind for the next `readSession` to pick up and
 * promote — a sign-out that puts the session back.
 */
export function clearSession(): void {
  for (const store of [storage('local'), storage('session')]) {
    remove(store, REFRESH_TOKEN_KEY);
    remove(store, USER_TYPE_KEY);
  }
}
