// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, readSession, writeSession } from '@/lib/session-storage';

/**
 * The session used to live in `sessionStorage`, which is PER TAB. A worker who
 * tapped a Jale link in WhatsApp got a brand-new tab, and that tab was signed
 * out even though the tab behind it was signed in — so the link they were sent
 * dropped them on a login screen. `localStorage` is shared across a browser's
 * tabs, which is the whole fix.
 *
 * Two things then have to hold, and both are pinned here:
 *   1. anyone already signed in must NOT be logged out by the switch — their
 *      existing `sessionStorage` session is migrated on the next read, and the
 *      old copy is only dropped once the new one is safely written;
 *   2. every access is wrapped, because reading or writing web storage THROWS
 *      outright in some privacy modes (Safari private browsing, "block all
 *      cookies") rather than returning null.
 */

const REFRESH_TOKEN_KEY = 'refreshToken';
const USER_TYPE_KEY = 'userType';

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

describe('readSession', () => {
    it('returns null when nothing is stored', () => {
        expect(readSession()).toBeNull();
    });

    it('reads a session from localStorage', () => {
        localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-1');
        localStorage.setItem(USER_TYPE_KEY, 'employer');

        expect(readSession()).toEqual({ refreshToken: 'rt-1', userType: 'employer' });
    });

    it('migrates a session left in sessionStorage by the old build', () => {
        // The load right after the deploy: the token is only in the per-tab
        // store. Logging this user out to change storage engines would be a
        // self-inflicted outage.
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(USER_TYPE_KEY, 'worker');

        expect(readSession()).toEqual({ refreshToken: 'rt-old', userType: 'worker' });
        // Promoted, so every other tab can see it from now on...
        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('rt-old');
        expect(localStorage.getItem(USER_TYPE_KEY)).toBe('worker');
        // ...and the per-tab copy is gone, so one refresh token is not left at
        // rest in two places.
        expect(sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
        expect(sessionStorage.getItem(USER_TYPE_KEY)).toBeNull();
    });

    it('migrates a session that has no stored user type', () => {
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');

        expect(readSession()).toEqual({ refreshToken: 'rt-old', userType: null });
        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('rt-old');
    });

    it('keeps the old copy when the promotion cannot be written', () => {
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(USER_TYPE_KEY, 'worker');
        breakStorage(window.localStorage, 'setItem');

        // The session still works for this tab — the read is what the caller
        // asked for, and losing it because the NEW store refused would log out
        // a signed-in user for no reason.
        expect(readSession()).toEqual({ refreshToken: 'rt-old', userType: 'worker' });
        // And the only surviving copy is still there: deleting it before the
        // replacement landed is how a migration destroys a session.
        expect(sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBe('rt-old');
    });

    it('prefers localStorage over a stale per-tab copy', () => {
        localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-current');
        localStorage.setItem(USER_TYPE_KEY, 'employer');
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-stale');
        sessionStorage.setItem(USER_TYPE_KEY, 'worker');

        expect(readSession()).toEqual({ refreshToken: 'rt-current', userType: 'employer' });
    });

    it('treats an unrecognised user type as unknown rather than trusting it', () => {
        // The value reaches an API call as `userType`, and it is attacker
        // writable (anything running on the origin can set it), so only the two
        // real values may survive the read.
        localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-1');
        localStorage.setItem(USER_TYPE_KEY, 'admin');

        expect(readSession()).toEqual({ refreshToken: 'rt-1', userType: null });
    });

    it('returns null when reading storage throws', () => {
        // Stored first, so a mock that failed to install would make this test
        // return a session and fail loudly rather than pass for free.
        localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-1');
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });

        expect(readSession()).toBeNull();
    });

    it('ignores an empty stored token', () => {
        localStorage.setItem(REFRESH_TOKEN_KEY, '');

        expect(readSession()).toBeNull();
    });
});

describe('writeSession', () => {
    it('writes the shared, cross-tab copy', () => {
        writeSession({ refreshToken: 'rt-2', userType: 'worker' });

        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('rt-2');
        expect(localStorage.getItem(USER_TYPE_KEY)).toBe('worker');
    });

    it('does not throw when storage refuses the write', () => {
        breakStorage(window.localStorage, 'setItem');

        // A refused write costs the user a remembered session, not the sign-in
        // they just completed: the tokens are in React state either way.
        expect(() => writeSession({ refreshToken: 'rt-2', userType: 'worker' })).not.toThrow();
        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    });
});

describe('clearSession', () => {
    it('clears both stores', () => {
        localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-1');
        localStorage.setItem(USER_TYPE_KEY, 'employer');
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');
        sessionStorage.setItem(USER_TYPE_KEY, 'worker');

        clearSession();

        // Logging out has to reach the pre-migration copy too, or a sign-out
        // would leave a token behind that the next read would happily promote.
        expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
        expect(localStorage.getItem(USER_TYPE_KEY)).toBeNull();
        expect(sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
        expect(sessionStorage.getItem(USER_TYPE_KEY)).toBeNull();
        expect(readSession()).toBeNull();
    });

    it('does not throw when storage refuses the removal', () => {
        sessionStorage.setItem(REFRESH_TOKEN_KEY, 'rt-old');
        breakStorage(window.localStorage, 'removeItem');

        expect(() => clearSession()).not.toThrow();
        // A store that refused must not stop the other one from being cleared.
        expect(sessionStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    });
});
