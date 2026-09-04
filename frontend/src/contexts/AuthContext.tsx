'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { getAuthBridge, registerAuthBridge } from '@/lib/auth-bridge';
import { buildLoginUrl } from '@/lib/login-url';
import { clearSession as clearStoredSession, readSession, writeSession } from '@/lib/session-storage';
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

function inferUserTypeFromPath(): UserType | null {
    if (typeof window === 'undefined') return null;
    const pathname = window.location.pathname;
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return null;
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

    // Picks the stored session up on every load, for BOTH user types — worker
    // and employer share this provider, so `@/lib/session-storage` is the one
    // place either session is read or written.
    useEffect(() => {
        const stored = readSession();
        const rt = stored?.refreshToken ?? null;
        const ut = stored?.userType ?? inferUserTypeFromPath();
        if (rt) {
            // Pin the type we inferred so a later refresh does not have to
            // guess it again from a path that may have changed.
            if (ut) writeSession({ refreshToken: rt, userType: ut });
            setRefreshToken(rt);
            setUserType(ut);
            apiFetch('/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: rt, userType: ut }),
            }).then(async (res) => {
                if (res.ok) {
                    const data = await res.json();
                    setAccessToken(data.accessToken);
                    setIdToken(data.idToken);
                } else {
                    clearStoredSession();
                    setRefreshToken(null);
                    setUserType(null);
                }
            }).catch(() => {
                clearStoredSession();
                setRefreshToken(null);
                setUserType(null);
            }).finally(() => setIsLoading(false));
        } else {
            setIsLoading(false);
        }
    }, []);

    const setTokens = (tokens: { accessToken: string; idToken: string; refreshToken: string }, ut: 'worker' | 'employer') => {
        setAccessToken(tokens.accessToken);
        setIdToken(tokens.idToken);
        setRefreshToken(tokens.refreshToken);
        setUserType(ut);
        writeSession({ refreshToken: tokens.refreshToken, userType: ut });
    };

    // Drops every trace of the session, locally — including the pre-migration
    // per-tab copy, so a sign-out cannot be undone by the next load promoting
    // a token it left behind. Stable identity (only setters and the storage
    // module), so the bridge below registers exactly once.
    const clearSession = useCallback(() => {
        clearStoredSession();
        setAccessToken(null);
        setIdToken(null);
        setRefreshToken(null);
        setUserType(null);
    }, []);

    const logout = async () => {
        await apiFetch('/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ accessToken, refreshToken, userType }),
        }).catch(() => {});
        clearSession();
        window.location.href = `/${locale}/`;
    };

    const refreshIdToken = useCallback(async (): Promise<string | null> => {
        // Single-flight: a burst of 401s (a page that fires five requests on
        // mount) must produce ONE /auth/refresh POST, not five -- Cognito
        // rotates on refresh, so parallel refreshes race each other's tokens.
        if (refreshInFlight.current) return refreshInFlight.current;

        const run = (async (): Promise<string | null> => {
            // Storage, not component state, is the source of truth here: the
            // bridge is registered once and must never close over a stale
            // token. Reading it also picks up a rotation done by another tab,
            // which is only possible now the session is shared.
            const stored = readSession();
            const rt = stored?.refreshToken ?? null;
            const ut = stored?.userType ?? null;
            if (!rt) {
                clearSession();
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
                    clearSession();
                    return null;
                }
                const data = await res.json();
                const nextIdToken = typeof data?.idToken === 'string' && data.idToken.length > 0
                    ? data.idToken
                    : null;
                if (!nextIdToken) {
                    clearSession();
                    return null;
                }
                setAccessToken(typeof data.accessToken === 'string' ? data.accessToken : null);
                setIdToken(nextIdToken);
                return nextIdToken;
            } catch {
                clearSession();
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
                // Read the identity BEFORE clearing it -- the login URL needs it.
                const ut = readSession()?.userType ?? inferUserTypeFromPath();
                const { pathname, search } = window.location;
                clearSession();
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

    return (
        <AuthContext.Provider value={{
            accessToken, refreshToken, idToken, userType,
            isAuthenticated: !!idToken,
            isLoading,
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
