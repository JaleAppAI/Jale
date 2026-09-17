'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { getAuthBridge, registerAuthBridge } from '@/lib/auth-bridge';
import { buildLoginUrl } from '@/lib/login-url';
import {
    clearSession as clearStoredSession,
    readRoleToken,
    readSession,
    subscribeToSignOut,
    writeSession,
} from '@/lib/session-storage';
import { clearSignageDismissals } from '@/lib/signage-storage';
import { clearSidebarChips } from '@/lib/sidebar-chip-storage';
import { locales } from '@/i18n/locales';

interface AuthState {
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    userType: 'worker' | 'employer' | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    /**
     * The last session this provider CLEARED, as a counter that only ever goes
     * up, with the role it cleared (null for a full sign-out of both).
     *
     * An explicit announcement rather than something a consumer infers from
     * `isAuthenticated` going false: that also happens while a role switch
     * re-reads the other slot, and on a route whose role this browser simply
     * has no session for. Neither is a session ending, and a cache that reacts
     * to them throws away perfectly good state (see `SidebarProfileContext`).
     */
    sessionCleared: SessionCleared;
    setTokens: (tokens: { accessToken: string; idToken: string; refreshToken: string }, userType: 'worker' | 'employer') => void;
    logout: () => Promise<void>;
    /**
     * Exchanges the stored refresh token for a fresh id token, which it
     * resolves. Resolves null (and clears the session) when the refresh token
     * is gone or rejected. Single-flight: concurrent callers share one
     * in-flight /auth/refresh POST.
     */
    refreshIdToken: () => Promise<string | null>;
}

type UserType = 'worker' | 'employer';

/** See `AuthState.sessionCleared`. `epoch` 0 is "nothing cleared yet". */
export type SessionCleared = { epoch: number; role: UserType | null };

const AuthContext = createContext<AuthState | null>(null);

/**
 * A refusal of the TOKEN, as opposed to the server having a bad day.
 *
 * Only this may drop a stored session. Every other failure -- a timeout, an
 * offline phone, a 5xx -- says nothing about whether the refresh token is
 * still good, and clearing on one of those is now broadcast to every OTHER TAB
 * of the browser (the slots are shared, and their removal is the cross-tab
 * sign-out signal), so a single bad request in a lift would sign a worker out
 * everywhere. A session that is genuinely gone costs one more round trip to
 * discover; a session thrown away is a sign-in the user has to redo.
 *
 * NOTE: `/auth/refresh` itself answers 401 for ANY Cognito failure, throttling
 * and outages included (infra/lambda/auth/token-refresh.ts), so this guard is
 * only as sharp as that lambda's status codes. Narrowing them is a backend
 * change and is reported rather than made here.
 */
function isTokenRefusal(res: { status?: number }): boolean {
    return res.status === 401 || res.status === 403;
}

/** The role a path belongs to, or null for one that names none. */
function roleFromPath(pathname: string): UserType | null {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return null;
}

function inferUserTypeFromPath(): UserType | null {
    if (typeof window === 'undefined') return null;
    return roleFromPath(window.location.pathname);
}

/**
 * The current route, as a value that CHANGES on a client-side navigation.
 *
 * `window.location` is read once per render and never announces anything, which
 * is exactly how the provider used to serve an employer page the worker session
 * it had restored on mount. `usePathname` is null outside an App Router (unit
 * tests, and any non-app render), so the address bar remains the fallback
 * rather than the source.
 */
function useRoutePathname(): string {
    const routerPathname = usePathname();
    if (routerPathname) return routerPathname;
    return typeof window === 'undefined' ? '' : window.location.pathname;
}

// Every app route is locale-prefixed by the middleware, so the first path
// segment is the locale. Anything unrecognised falls back to the default.
function localeFromPathname(pathname: string): string {
    const first = pathname.split('/')[1];
    return (locales as readonly string[]).includes(first) ? first : 'en';
}

export function AuthProvider({ children, locale }: { children: React.ReactNode; locale: string }) {
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [refreshToken, setRefreshToken] = useState<string | null>(null);
    const [idToken, setIdToken] = useState<string | null>(null);
    const [userType, setUserType] = useState<'worker' | 'employer' | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [sessionCleared, setSessionCleared] = useState<SessionCleared>({ epoch: 0, role: null });
    const refreshInFlight = useRef<Promise<string | null> | null>(null);
    /**
     * The role this provider is signed in as, readable from callbacks that
     * were registered once and would otherwise close over stale state (the
     * auth bridge). It is what keeps a refresh on the right side of the
     * worker/employer split.
     */
    const userTypeRef = useRef<UserType | null>(null);

    const rememberUserType = (next: UserType | null) => {
        userTypeRef.current = next;
        setUserType(next);
    };

    /**
     * Drops this provider's session, locally, and ANNOUNCES it.
     *
     * `role` scopes it, and callers pass the role they were actually signed in
     * as: clearing both slots would sign the other role out of every tab in
     * the browser. It also removes a pre-migration copy of that role's session,
     * so a sign-out cannot be undone by the next load promoting a token it left
     * behind.
     *
     * This is the ONLY way a session ends, which is what makes `sessionCleared`
     * worth subscribing to: every other "not authenticated" render is a role
     * switch in progress or a route whose role this browser was never signed in
     * as.
     *
     * Stable identity (only setters and the storage module), so the bridge
     * below registers exactly once.
     */
    const clearSession = useCallback((role?: UserType) => {
        clearStoredSession(role);
        // The sidebar chip's reload cache goes with the session, synchronously
        // and for the SAME role: `logout` assigns `window.location.href` right
        // after this, and an effect reacting to the announcement below is not
        // guaranteed to run before that navigation. Leaving it would paint the
        // name of the account that just signed out over the next one's first
        // frame -- and clearing both roles would blank a chip belonging to a
        // session that is still perfectly signed in.
        clearSidebarChips(role);
        // Same reasoning, for the billing banners: a dismissal is one account's
        // answer, and the next account to sign in on this browser has not given
        // one. Unscoped, because sign-out is the moment we can be sure nobody
        // is still reading them.
        clearSignageDismissals();
        setSessionCleared((prev) => ({ epoch: prev.epoch + 1, role: role ?? null }));
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        userTypeRef.current = null;
        setUserType(null);
    }, []);

    /**
     * The route role whose session this provider has finished resolving.
     *
     * `undefined` until the first restore lands, which is what keeps
     * `isLoading` true on the very first render. A route that names no role
     * settles on the role it ended up restoring, so walking from the landing
     * page into that role's own pages is not a second restore.
     */
    const [settledFor, setSettledFor] = useState<UserType | null | undefined>(undefined);
    /** Supersedes an in-flight restore when the route changes under it. */
    const restoreGenerationRef = useRef(0);

    const routeRole = roleFromPath(useRoutePathname());
    /**
     * A restore for the CURRENT route has not finished. Derived during render,
     * deliberately: effects run child-first, so a page's own fetch effect fires
     * BEFORE this provider's restore effect on the render a navigation lands
     * on. Anything less than a render-time signal lets that page fetch with the
     * role it is leaving — the 401 this whole mechanism exists to prevent.
     */
    const restorePending = settledFor === undefined
        || (routeRole !== null && settledFor !== routeRole);

    // Restores the session THIS ROUTE's role is signed in as — on every load,
    // and again whenever a client-side navigation crosses the worker/employer
    // line. The store keeps a slot per role, so every read says which role is
    // asking; otherwise a browser with both sessions open would restore
    // whichever was written last.
    useEffect(() => {
        if (!restorePending) return;

        const generation = (restoreGenerationRef.current += 1);
        const settle = (role: UserType | null) => {
            if (restoreGenerationRef.current !== generation) return;
            setSettledFor(role);
            setIsLoading(false);
        };

        // Already serving this role (arrived from a neutral route, or signed in
        // on the auth page next door): record it, refresh nothing.
        if (routeRole !== null && userTypeRef.current === routeRole) {
            settle(routeRole);
            return;
        }

        // The other role's tokens go FIRST and unconditionally. Until the new
        // slot answers, this tab holds no session at all — handing a page the
        // token it had a moment ago is the bug, not a stopgap.
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        rememberUserType(null);
        setIsLoading(true);

        const stored = readSession(routeRole);
        const rt = stored?.refreshToken ?? null;
        const ut = stored?.userType ?? routeRole;
        if (!rt) {
            // No session for this route's role. Not an error and not a reason
            // to touch the OTHER role's slot: `useRequireAuth` sends the
            // visitor to this role's own sign-in door.
            settle(routeRole);
            return;
        }

        // Pin the role we inferred, so a later refresh reads a slot rather
        // than guessing again from a path that may have changed.
        if (ut) writeSession({ refreshToken: rt, userType: ut });
        setRefreshToken(rt);
        rememberUserType(ut);
        apiFetch('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: rt, userType: ut }),
        }).then(async (res) => {
            if (res.ok) {
                const data = await res.json();
                // A navigation that happened while this was in flight owns the
                // provider now; landing the old role's tokens on top of it is
                // precisely what the generation guard is for.
                if (restoreGenerationRef.current !== generation) return;
                setAccessToken(data.accessToken);
                setIdToken(data.idToken);
                return;
            }
            if (restoreGenerationRef.current !== generation) return;
            if (isTokenRefusal(res)) {
                // Scoped to the role whose token was just refused: the
                // other role's session is still perfectly good. Through
                // `clearSession`, so the announcement and the chip cache are
                // not left to whoever edits this branch next.
                clearSession(ut ?? undefined);
                return;
            }
            // An OUTAGE, and nothing happens to the session because of it.
            // The stored slot stays (removing it is broadcast to every other
            // tab as a sign-out) and so do the in-memory refresh token and
            // role, so the next `refreshIdToken` has something to retry with.
            // This route just has no id token for now, which `useRequireAuth`
            // turns into the sign-in door -- a screen the visitor can act on,
            // where a cleared session is a sign-in they have to redo.
        }).catch(() => {
            // Thrown, so the request got no answer at all: a timeout, an
            // offline phone, a DNS failure (`ApiError(0)`, lib/api.ts).
            // Emphatically not a refusal, so -- exactly as above -- the
            // session is left alone and the generation guard is the only
            // reason this branch reads anything.
        }).finally(() => settle(routeRole ?? ut ?? null));
    }, [restorePending, routeRole, clearSession]);

    /**
     * A sign-out in ANOTHER TAB of this browser.
     *
     * Only this provider's own role is acted on: the slots are keyed precisely
     * so that signing out of the employer account leaves the worker in the next
     * tab alone. The redirect is scoped the same way — a tab parked on a role
     * page has nothing left to show and goes to that role's door, while one on
     * the landing page or a legal page simply stops being signed in rather than
     * being yanked onto a login screen it never asked for.
     */
    useEffect(() => subscribeToSignOut((role) => {
        if (userTypeRef.current !== role) return;
        // Retires any restore still in flight: its response would otherwise
        // land tokens for the session that has just been signed out.
        restoreGenerationRef.current += 1;
        // The same exit every other sign-out takes -- the slot is already gone
        // (the other tab removed it, which is how this fired), and going
        // through here is what announces it and drops this role's chip cache.
        clearSession(role);
        setSettledFor(role);
        setIsLoading(false);
        const { pathname, search } = window.location;
        if (roleFromPath(pathname) !== role) return;
        window.location.assign(
            buildLoginUrl(localeFromPathname(pathname), role, `${pathname}${search}`),
        );
    }), [clearSession]);

    const setTokens = (tokens: { accessToken: string; idToken: string; refreshToken: string }, ut: 'worker' | 'employer') => {
        setAccessToken(tokens.accessToken);
        setIdToken(tokens.idToken);
        setRefreshToken(tokens.refreshToken);
        rememberUserType(ut);
        // Only this role's slot: signing in as an employer must not sign a
        // worker in the next tab out.
        writeSession({ refreshToken: tokens.refreshToken, userType: ut });
    };

    const logout = async () => {
        await apiFetch('/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ accessToken, refreshToken, userType }),
        }).catch(() => {});
        clearSession(userType ?? undefined);
        window.location.href = `/${locale}/`;
    };

    const refreshIdToken = useCallback(async (): Promise<string | null> => {
        // Single-flight: a burst of 401s (a page that fires five requests on
        // mount) must produce ONE /auth/refresh POST, not five -- Cognito
        // rotates on refresh, so parallel refreshes race each other's tokens.
        if (refreshInFlight.current) return refreshInFlight.current;

        const run = (async (): Promise<string | null> => {
            // Storage, not component state, is the source of truth for the
            // TOKEN: the bridge is registered once and must never close over a
            // stale one, and re-reading also picks up a rotation done by
            // another tab, which is only possible now the session is shared.
            //
            // The ROLE comes from this provider (via a ref, for the same
            // stale-closure reason) and the token is read from that role's slot
            // ONLY. Taking "whatever is stored" would, in a browser signed in
            // as both, refresh the other role's token and hand this tab an id
            // token for the wrong pool.
            const role = userTypeRef.current;
            const stored = role
                ? { refreshToken: readRoleToken(role), userType: role as UserType | null }
                // No role yet (a 401 before the session was restored): fall
                // back to what the route implies, which is what the mount
                // effect would have used.
                : readSession(inferUserTypeFromPath());
            const rt = stored?.refreshToken ?? null;
            const ut = stored?.userType ?? null;
            if (!rt) {
                // Never unscoped: `clearSession(undefined)` wipes BOTH role
                // slots, and since a role route with only the OTHER role
                // signed in now resolves to no session at all, an unscoped
                // clear here would sign that other role out too.
                clearSession(ut ?? inferUserTypeFromPath() ?? undefined);
                return null;
            }
            try {
                // Deliberately token-less, so apiFetch's own 401 refresh path
                // never intercepts it (that would recurse).
                const res = await apiFetch('/auth/refresh', {
                    method: 'POST',
                    body: JSON.stringify({ refreshToken: rt, userType: ut }),
                });
                if (!res.ok) {
                    // Only a refusal ends the session; an outage leaves it
                    // stored and in memory for the next attempt. See
                    // `isTokenRefusal` -- and note that clearing here removes
                    // the shared slot, which signs every OTHER TAB out too.
                    if (isTokenRefusal(res)) clearSession(ut ?? undefined);
                    return null;
                }
                const data = await res.json();
                const nextIdToken = typeof data?.idToken === 'string' && data.idToken.length > 0
                    ? data.idToken
                    : null;
                if (!nextIdToken) {
                    clearSession(ut ?? undefined);
                    return null;
                }
                setAccessToken(typeof data.accessToken === 'string' ? data.accessToken : null);
                setIdToken(nextIdToken);
                return nextIdToken;
            } catch {
                // Never reached the server (timeout, offline, DNS): the caller
                // gets no token and will surface its own error, but the stored
                // session is not this request's to throw away.
                return null;
            }
        })();

        refreshInFlight.current = run;
        try {
            return await run;
        } finally {
            refreshInFlight.current = null;
        }
    }, [clearSession]);

    // Hand the transport layer a way back into React auth state. Both deps are
    // stable, so this registers once per provider instance.
    useEffect(() => {
        const bridge = {
            refreshIdToken,
            onSessionExpired: () => {
                // Read the identity BEFORE clearing it -- the login URL needs
                // it, and only this role is being signed out.
                const ut = userTypeRef.current
                    ?? readSession(inferUserTypeFromPath())?.userType
                    ?? inferUserTypeFromPath();
                const { pathname, search } = window.location;
                clearSession(ut ?? undefined);
                window.location.assign(
                    buildLoginUrl(localeFromPathname(pathname), ut, `${pathname}${search}`),
                );
            },
        };
        registerAuthBridge(bridge);
        return () => {
            // Only clear our own registration: never clobber a provider that
            // already replaced us.
            if (getAuthBridge() === bridge) registerAuthBridge(null);
        };
    }, [refreshIdToken, clearSession]);

    /**
     * Whether what is in memory belongs to the route being rendered.
     *
     * False for exactly one thing: a session for the OTHER role, on a route
     * that names a role. Everything below is masked in that case, so no
     * descendant can read — let alone send — a token from the wrong pool
     * during the renders between the navigation and the restore above.
     */
    const serving = routeRole === null || userType === null || userType === routeRole;

    return (
        <AuthContext.Provider value={{
            accessToken: serving ? accessToken : null,
            refreshToken: serving ? refreshToken : null,
            idToken: serving ? idToken : null,
            userType: serving ? userType : null,
            isAuthenticated: serving && !!idToken,
            isLoading: isLoading || restorePending,
            sessionCleared,
            setTokens, logout, refreshIdToken,
        }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
