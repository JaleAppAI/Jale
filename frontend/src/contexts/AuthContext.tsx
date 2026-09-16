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
import { locales } from '@/i18n/locales';

interface AuthState {
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    userType: 'worker' | 'employer' | null;
    isAuthenticated: boolean;
    isLoading: boolean;
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

const AuthContext = createContext<AuthState | null>(null);

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
            } else {
                if (restoreGenerationRef.current !== generation) return;
                // Scoped to the role whose token was just refused: the
                // other role's session is still perfectly good.
                clearStoredSession(ut ?? undefined);
                setRefreshToken(null);
                rememberUserType(null);
            }
        }).catch(() => {
            if (restoreGenerationRef.current !== generation) return;
            clearStoredSession(ut ?? undefined);
            setRefreshToken(null);
            rememberUserType(null);
        }).finally(() => settle(routeRole ?? ut ?? null));
    }, [restorePending, routeRole]);

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
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        rememberUserType(null);
        setSettledFor(role);
        setIsLoading(false);
        const { pathname, search } = window.location;
        if (roleFromPath(pathname) !== role) return;
        window.location.assign(
            buildLoginUrl(localeFromPathname(pathname), role, `${pathname}${search}`),
        );
    }), []);

    const setTokens = (tokens: { accessToken: string; idToken: string; refreshToken: string }, ut: 'worker' | 'employer') => {
        setAccessToken(tokens.accessToken);
        setIdToken(tokens.idToken);
        setRefreshToken(tokens.refreshToken);
        rememberUserType(ut);
        // Only this role's slot: signing in as an employer must not sign a
        // worker in the next tab out.
        writeSession({ refreshToken: tokens.refreshToken, userType: ut });
    };

    /**
     * Drops this provider's session, locally.
     *
     * `role` scopes the storage side of it, and callers pass the role they were
     * actually signed in as: clearing both slots would sign the other role out
     * of every tab in the browser. It also removes a pre-migration copy of that
     * role's session, so a sign-out cannot be undone by the next load promoting
     * a token it left behind.
     *
     * Stable identity (only setters and the storage module), so the bridge
     * below registers exactly once.
     */
    const clearSession = useCallback((role?: UserType) => {
        clearStoredSession(role);
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        userTypeRef.current = null;
        setUserType(null);
    }, []);

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
                    clearSession(ut ?? undefined);
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
                clearSession(ut ?? undefined);
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
