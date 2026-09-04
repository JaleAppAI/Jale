// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, readRoleToken, readSession, writeSession } from '@/lib/session-storage';

/**
 * The session used to live in `sessionStorage`, which is PER TAB. A worker who
 * tapped a Jale link inside WhatsApp got a brand-new tab, and that tab was
 * signed out even though the tab behind it was signed in — so every share link
 * the product sends looked broken. `localStorage` is shared across a browser's
 * tabs, which is the fix.
 *
 * But a single shared slot would have traded that bug for a worse one: this
 * product is routinely used with a WORKER session and an EMPLOYER session open
 * in the same browser (the owner and the testers do it daily), and one slot
 * means the second sign-in silently overwrites the first — and can hand a tab
 * the other role's tokens on its next refresh. So the store is keyed BY ROLE,
 * and every read says which role is asking.
 *
 * Three further things have to hold, and all three are pinned here:
 *   1. nobody already signed in may be logged out by the change — a session
 *      written by an older build is promoted into its role's slot on the next
 *      read, and the old copy is only dropped once the new one is written;
 *   2. signing out of one role must not touch the other;
 *   3. every access is wrapped, because reading or writing web storage THROWS
 *      outright in some privacy modes rather than returning null.
 */

const WORKER_SLOT = 'jale.session.worker';
const EMPLOYER_SLOT = 'jale.session.employer';
const LAST_ROLE_KEY = 'jale.session.lastRole';
const LEGACY_TOKEN_KEY = 'refreshToken';
const LEGACY_USER_TYPE_KEY = 'userType';

/**
 * Makes ONE of the two stores throw, the way a locked-down browser does.
 *
 * The spy has to go on `Storage.prototype`, not on the `localStorage` object:
 * jsdom serves each store through a Proxy whose `defineProperty` trap treats
 * any key as a stored ITEM, so `vi.spyOn(window.localStorage, 'setItem')`
 * quietly writes an entry called "setItem" and the real method keeps running —
 * a mock that never fires, in a test that then proves nothing.
 */
function breakStorage(store: Storage, method: 'getItem' | 'setItem' | 'removeItem') {
    const real = Storage.prototype[method] as (this: Storage, ...args: unknown[]) => unknown;
    const patched = function (this: Storage, ...args: unknown[]) {
        if (this === store) throw new Error('storage disabled');
        return real.apply(this, args);
    };
    // `method` is a union of three different signatures, so the mock cannot be
    // typed against all of them at once; the runtime shape is exercised by the
    // tests below.
    vi.spyOn(Storage.prototype, method).mockImplementation(patched as never);
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('readSession — two roles, side by side', () => {
    beforeEach(() => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        localStorage.setItem(LAST_ROLE_KEY, 'employer');
    });

    it('gives a worker route the worker session', () => {
        expect(readSession('worker')).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
    });

    it('gives an employer route the employer session', () => {
        expect(readSession('employer')).toEqual({ refreshToken: 'rt-employer', userType: 'employer' });
    });

    it('falls back to the most recently written role where the route says nothing', () => {
        // Landing page, /auth/*, a legal page: no role in the path, so the last
        // sign-in is the best guess at whose browser tab this is.
        expect(readSession(null)).toEqual({ refreshToken: 'rt-employer', userType: 'employer' });

        localStorage.setItem(LAST_ROLE_KEY, 'worker');
        expect(readSession(null)).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
    });

    it('ignores an unusable last-role marker rather than returning nothing', () => {
        localStorage.setItem(LAST_ROLE_KEY, 'admin');

        const session = readSession(null);
        expect(session?.refreshToken).toBeTypeOf('string');
        expect(['worker', 'employer']).toContain(session?.userType);
    });
});

describe('readSession — one role stored', () => {
    it('returns null when nothing is stored', () => {
        expect(readSession('worker')).toBeNull();
        expect(readSession(null)).toBeNull();
    });

    it('returns the only session there is, whatever the route asked for', () => {
        // An employer who opens a /worker/... URL still has exactly one
        // session, and it is the one this provider must restore — the auth
        // pages already route a mismatched role to its own home.
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        expect(readSession('worker')).toEqual({ refreshToken: 'rt-employer', userType: 'employer' });
        expect(readSession(null)).toEqual({ refreshToken: 'rt-employer', userType: 'employer' });
    });

    it('ignores an empty stored token', () => {
        localStorage.setItem(WORKER_SLOT, '');

        expect(readSession('worker')).toBeNull();
    });

    it('returns null when reading storage throws', () => {
        // Stored first, so a mock that failed to install would return a session
        // and fail loudly rather than let this pass for free.
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });

        expect(readSession('worker')).toBeNull();
    });
});

describe('readRoleToken', () => {
    it('reads only the role it was asked for', () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        expect(readRoleToken('worker')).toBe('rt-worker');
        expect(readRoleToken('employer')).toBe('rt-employer');
    });

    it('never substitutes the other role', () => {
        // This is what a token refresh uses. Falling back here would refresh
        // the wrong pool and drop the OTHER role's id token into this tab.
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        expect(readRoleToken('worker')).toBeNull();
    });
});

describe('readSession — migrating a session from an older build', () => {
    it('promotes a per-tab worker session into the worker slot', () => {
        // The load right after the deploy: the token is only in the per-tab
        // store. Logging this user out to change storage engines would be a
        // self-inflicted outage.
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(LEGACY_USER_TYPE_KEY, 'worker');

        expect(readSession('worker')).toEqual({ refreshToken: 'rt-old', userType: 'worker' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-old');
        expect(localStorage.getItem(LAST_ROLE_KEY)).toBe('worker');
        // The employer slot is not collateral damage.
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull();
        // And the per-tab copy is gone, so one refresh token is not left at
        // rest in two places.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
        expect(sessionStorage.getItem(LEGACY_USER_TYPE_KEY)).toBeNull();
    });

    it('promotes a shared-but-unkeyed session written by the interim build', () => {
        localStorage.setItem(LEGACY_TOKEN_KEY, 'rt-interim');
        localStorage.setItem(LEGACY_USER_TYPE_KEY, 'employer');

        expect(readSession('employer')).toEqual({ refreshToken: 'rt-interim', userType: 'employer' });
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-interim');
        expect(localStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    });

    it('names the slot from the route when the old session did not record a role', () => {
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');

        expect(readSession('employer')).toEqual({ refreshToken: 'rt-old', userType: 'employer' });
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-old');
    });

    it('still hands back an old session it cannot attribute to a role', () => {
        // No stored role, no role in the path. Nothing can be promoted, but
        // logging the user out over it would be strictly worse.
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');

        expect(readSession(null)).toEqual({ refreshToken: 'rt-old', userType: null });
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBe('rt-old');
    });

    it('does not let a stale leftover overwrite a slot this build wrote', () => {
        localStorage.setItem(WORKER_SLOT, 'rt-current');
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-stale');
        sessionStorage.setItem(LEGACY_USER_TYPE_KEY, 'worker');

        expect(readSession('worker')).toEqual({ refreshToken: 'rt-current', userType: 'worker' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-current');
        // The leftover is retired rather than left to be promoted later.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    });

    it('keeps the old copy when the promotion cannot be written', () => {
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(LEGACY_USER_TYPE_KEY, 'worker');
        breakStorage(window.localStorage, 'setItem');

        // The session still works for this tab — losing it because the NEW
        // store refused would log out a signed-in user for no reason.
        expect(readSession('worker')).toEqual({ refreshToken: 'rt-old', userType: 'worker' });
        // And the only surviving copy is still there: deleting it before the
        // replacement landed is how a migration destroys a session.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBe('rt-old');
    });
});

describe('writeSession', () => {
    it('writes only that role, and records it as the most recent', () => {
        writeSession({ refreshToken: 'rt-worker', userType: 'worker' });
        writeSession({ refreshToken: 'rt-employer', userType: 'employer' });

        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-employer');
        expect(localStorage.getItem(LAST_ROLE_KEY)).toBe('employer');
        // Signing in as the second role must not have cost the first one its
        // session — the whole point of keying by role.
        expect(readSession('worker')).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
    });

    it('replaces the token for the same role', () => {
        writeSession({ refreshToken: 'rt-1', userType: 'worker' });
        writeSession({ refreshToken: 'rt-2', userType: 'worker' });

        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-2');
    });

    it('does not throw when storage refuses the write', () => {
        breakStorage(window.localStorage, 'setItem');

        // A refused write costs the user a remembered session, not the sign-in
        // they just completed: the tokens are in React state either way.
        expect(() => writeSession({ refreshToken: 'rt-2', userType: 'worker' })).not.toThrow();
        expect(localStorage.getItem(WORKER_SLOT)).toBeNull();
    });
});

describe('clearSession', () => {
    it('signs one role out and leaves the other signed in', () => {
        writeSession({ refreshToken: 'rt-worker', userType: 'worker' });
        writeSession({ refreshToken: 'rt-employer', userType: 'employer' });

        clearSession('employer');

        expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull();
        expect(readSession('worker')).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
        // The marker cannot keep pointing at a role that no longer has a
        // session, or a neutral route would resolve to nothing.
        expect(readSession(null)).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
    });

    it('drops the legacy copy belonging to that role only', () => {
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old-worker');
        sessionStorage.setItem(LEGACY_USER_TYPE_KEY, 'worker');

        clearSession('employer');

        // Someone else's un-promoted session is not this sign-out's business.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBe('rt-old-worker');

        clearSession('worker');

        // Its owner signing out is: otherwise the next read would promote it
        // and put the session back.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    });

    it('clears everything when no role is named', () => {
        writeSession({ refreshToken: 'rt-worker', userType: 'worker' });
        writeSession({ refreshToken: 'rt-employer', userType: 'employer' });
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(LEGACY_USER_TYPE_KEY, 'worker');

        clearSession();

        expect(localStorage.getItem(WORKER_SLOT)).toBeNull();
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull();
        expect(localStorage.getItem(LAST_ROLE_KEY)).toBeNull();
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
        expect(readSession(null)).toBeNull();
    });

    it('does not throw when storage refuses the removal', () => {
        sessionStorage.setItem(LEGACY_TOKEN_KEY, 'rt-old');
        breakStorage(window.localStorage, 'removeItem');

        expect(() => clearSession()).not.toThrow();
        // A store that refused must not stop the other one from being cleared.
        expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
    });
});
