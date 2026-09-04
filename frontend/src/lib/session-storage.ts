// Where the browser keeps the signed-in session between loads.
//
// TWO DECISIONS, each fixing a distinct failure.
//
// 1) `localStorage`, not `sessionStorage`. `sessionStorage` is scoped to one
//    tab: a worker who tapped a Jale link inside WhatsApp got a fresh tab with
//    an empty store and was shown a login screen, even with a signed-in Jale
//    tab sitting right behind it. Every share link the product sends is opened
//    that way, so the per-tab session made the most common entry point into
//    the app look broken.
//
// 2) One slot PER ROLE, not one shared slot. This product is routinely used
//    with a worker session and an employer session open in the same browser.
//    With a single `refreshToken`/`userType` pair, the second sign-in silently
//    overwrites the first, and the first tab then refreshes the surviving token
//    and lands the OTHER role's id token in a page built for its own role. Slots
//    are keyed `jale.session.<role>`, every read says which role is asking, and
//    signing out of one role does not touch the other.
//
// Still not solved, and documented rather than papered over: a sign-out does
// not propagate to tabs that are already open. Another tab keeps working off
// its in-memory id token until its next refresh, which then finds an empty slot
// and clears itself. Making that instant needs a `storage`-event listener,
// which is deliberately not part of this change.
//
// Two constraints shape the rest.
//
// A) Nobody may be logged out by the change. A session written by an older
//    build lives in the un-keyed `refreshToken`/`userType` pair (in
//    `sessionStorage` from the original build, in `localStorage` from the
//    interim one), so the first read promotes it into its role's slot and only
//    then drops the old copy — and if the promotion cannot be written, the old
//    copy STAYS, because a migration that deletes the only copy of a live token
//    is worse than not migrating at all.
//
// B) Every access is wrapped. Reading or writing web storage does not merely
//    return null in a locked-down browser (Safari private browsing, "block all
//    cookies", enterprise policy) — the property access itself throws. An
//    unguarded `localStorage.getItem` in a provider's mount effect takes the
//    whole app down for those visitors.
//
// What is stored is a REFRESH token per role, which is what the old code kept
// too: web storage is readable by anything running on the origin, so this is
// not a place for the access or id token, and the tradeoff (a session that
// survives a reload) is the one the product already made.

export type StoredUserType = 'worker' | 'employer';

export type StoredSession = {
  refreshToken: string;
  /**
   * Which pool the token belongs to. Null only for a legacy session that
   * recorded no role and arrived on a route that implies none — see
   * `readSession`.
   */
  userType: StoredUserType | null;
};

const ROLES: readonly StoredUserType[] = ['worker', 'employer'];

/** Namespaced, so these keys cannot collide with a page's own storage. */
function slotKey(role: StoredUserType): string {
  return `jale.session.${role}`;
}

/** Which role signed in last — the tie-breaker for a route that names none. */
const LAST_ROLE_KEY = 'jale.session.lastRole';

// The un-keyed pair written by builds before this file existed.
const LEGACY_TOKEN_KEY = 'refreshToken';
const LEGACY_USER_TYPE_KEY = 'userType';

/**
 * Only the two real values survive a read. Anything running on the origin can
 * write these keys, and the value is forwarded to the API as `userType`, so a
 * stored "admin" must come back as "no idea" rather than as itself.
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

type LegacySession = {
  /** Which store it was found in — only that one gets cleaned up. */
  store: Storage;
  token: string;
  role: StoredUserType | null;
};

/** The un-keyed session an older build left behind, wherever it put it. */
function findLegacySession(): LegacySession | null {
  for (const kind of ['local', 'session'] as const) {
    const store = storage(kind);
    if (!store) continue;
    const token = read(store, LEGACY_TOKEN_KEY);
    if (token) {
      return { store, token, role: parseUserType(read(store, LEGACY_USER_TYPE_KEY)) };
    }
  }
  return null;
}

function removeLegacySession(store: Storage | undefined): void {
  remove(store, LEGACY_TOKEN_KEY);
  remove(store, LEGACY_USER_TYPE_KEY);
}

/**
 * Moves an older build's session into its role's slot, once.
 *
 * Returns the legacy session ONLY when it is still the sole copy — either
 * because no role could be named for it, or because the slot write was refused
 * — so `readSession` can still hand it back instead of logging the user out.
 */
function promoteLegacySession(preferred: StoredUserType | null): LegacySession | null {
  const legacy = findLegacySession();
  if (!legacy) return null;

  // The role it recorded, else the one the current route implies. A session
  // that can be attributed to neither is left exactly where it is.
  const role = legacy.role ?? preferred;
  if (!role) return legacy;

  const local = storage('local');
  if (read(local, slotKey(role))) {
    // This build already wrote that slot, so the leftover is stale. Retire it
    // rather than leave it to be promoted over a newer token later.
    removeLegacySession(legacy.store);
    return null;
  }

  if (!write(local, slotKey(role), legacy.token)) return legacy;
  write(local, LAST_ROLE_KEY, role);
  // Only now: while the slot did not exist, the legacy copy WAS the session.
  removeLegacySession(legacy.store);
  return null;
}

/**
 * The token for exactly one role, and never a substitute.
 *
 * This is what a token refresh reads. `readSession`'s fallbacks are wrong
 * there: with both roles signed in, refreshing "whatever is stored" would
 * exchange the other role's token and drop its id token into a tab built for
 * this one.
 */
export function readRoleToken(userType: StoredUserType): string | null {
  return read(storage('local'), slotKey(userType)) || null;
}

/**
 * The session to restore on this route, or null when there is none.
 *
 * `preferred` is the role the current path implies (`/worker/...`,
 * `/employer/...`), or null on a route that implies none — the landing page,
 * `/auth/*`, the legal pages. Resolution order:
 *
 *   1. `preferred`'s own slot, so a worker route restores the worker session
 *      even when an employer session is also stored;
 *   2. the only populated slot, if there is exactly one — an employer opening a
 *      `/worker/...` URL still has one session, and the auth pages already
 *      route a mismatched role to its own home;
 *   3. with both populated and no preference, whichever signed in last;
 *   4. a legacy session that could not be promoted (see `promoteLegacySession`),
 *      because logging that user out would be strictly worse than restoring it
 *      with an unknown role.
 */
export function readSession(preferred: StoredUserType | null): StoredSession | null {
  const leftover = promoteLegacySession(preferred);
  const local = storage('local');

  if (preferred) {
    const token = read(local, slotKey(preferred));
    if (token) return { refreshToken: token, userType: preferred };
  }

  const populated = ROLES
    .map((role) => ({ role, token: read(local, slotKey(role)) }))
    .filter((slot): slot is { role: StoredUserType; token: string } => !!slot.token);

  if (populated.length === 1) {
    return { refreshToken: populated[0].token, userType: populated[0].role };
  }
  if (populated.length > 1) {
    const lastRole = parseUserType(read(local, LAST_ROLE_KEY));
    const chosen = populated.find((slot) => slot.role === lastRole) ?? populated[0];
    return { refreshToken: chosen.token, userType: chosen.role };
  }

  if (leftover) return { refreshToken: leftover.token, userType: leftover.role };
  return null;
}

/**
 * Stores one role's session for every tab on this origin, leaving the other
 * role's alone. Never throws.
 */
export function writeSession(session: { refreshToken: string; userType: StoredUserType }): void {
  const local = storage('local');
  if (write(local, slotKey(session.userType), session.refreshToken)) {
    write(local, LAST_ROLE_KEY, session.userType);
  }
}

/**
 * Signs out. With a role, ONLY that role: the other one stays signed in, which
 * is the whole reason the slots are keyed.
 *
 * The legacy keys are included, because a user who signs out before their old
 * session was ever promoted would otherwise leave a token behind for the next
 * `readSession` to promote — a sign-out that puts the session back. On a
 * role-scoped clear they are only removed when they belong to that role (or
 * name no role at all, in which case nothing else can claim them): the other
 * role's un-promoted session is not this sign-out's business.
 */
export function clearSession(userType?: StoredUserType): void {
  const local = storage('local');

  for (const role of userType ? [userType] : ROLES) {
    remove(local, slotKey(role));
  }

  const legacy = findLegacySession();
  if (legacy && (!userType || !legacy.role || legacy.role === userType)) {
    removeLegacySession(legacy.store);
  }

  if (!userType) {
    remove(local, LAST_ROLE_KEY);
    return;
  }

  // The marker must not keep pointing at a role that no longer has a session,
  // or a neutral route would resolve to nothing at all.
  if (parseUserType(read(local, LAST_ROLE_KEY)) !== userType) return;
  const survivor = ROLES.find((role) => role !== userType && read(local, slotKey(role)));
  if (survivor) write(local, LAST_ROLE_KEY, survivor);
  else remove(local, LAST_ROLE_KEY);
}
