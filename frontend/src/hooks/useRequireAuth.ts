'use client';
import { useCallback, useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter as useNextRouter } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { isLegalWallError } from '@/lib/api';
import { buildLoginUrl } from '@/lib/login-url';

type UserType = 'worker' | 'employer';

/** The role a path is about, or null for one that is about neither. */
function roleFromPath(pathname: string): UserType | null {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return null;
}

/**
 * Where the login page should send the user back to, read from the address bar.
 *
 * NOT from next-intl's `usePathname`: that strips the locale, and a return URL
 * without one drops a Spanish-speaking worker into the English tree (the same
 * reason `AuthContext.onSessionExpired` reads `window.location`). Undefined
 * during SSR, where there is no address bar and no redirect to build.
 */
function currentReturnPath(): string | undefined {
    if (typeof window === 'undefined') return undefined;
    return `${window.location.pathname}${window.location.search}`;
}

type UseRequireAuthOptions = {
    /**
     * Whether the sign-in redirect is armed. Defaults to `true`, so every
     * existing `useRequireAuth()` call site behaves exactly as before.
     *
     * `usePageData({ requireAuth: false })` passes `false`: those pages still
     * want the legal-wall handling below (which is why they call this hook at
     * all) but must not bounce an anonymous visitor to /auth.
     */
    enabled?: boolean;
    /**
     * Whose page this is. Defaults to the role the path names
     * (`/worker/...`, `/employer/...`), which is right for every route that
     * names one; a page on a neutral path that still belongs to a role says so
     * here.
     *
     * It decides two things: which session's id token the page is handed, and
     * which sign-in door an unauthenticated visitor is sent to. This product is
     * routinely used with a worker session and an employer session open in the
     * same browser, and before the role was part of the question, walking from
     * a worker page to an employer one left the page fetching with the token it
     * had just left -- a 401/403 until the visitor reloaded by hand.
     */
    role?: UserType;
};

export function useRequireAuth({ enabled = true, role }: UseRequireAuthOptions = {}) {
    const { idToken, isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    // Two routers on purpose. `buildLoginUrl` returns an ALREADY
    // locale-prefixed path, so it goes through Next's own router; next-intl's
    // would prefix a second locale onto it (`/es/es/auth/worker`). The
    // locale-less `/legal/accept` hop below still wants the next-intl one.
    const nextRouter = useNextRouter();
    const locale = useLocale();
    const pathname = usePathname();

    const requiredRole = role ?? roleFromPath(pathname);
    /**
     * The session on screen belongs to this page's role.
     *
     * A null `userType` is "no opinion", not a mismatch: that is a visitor with
     * no session at all, which the `isAuthenticated` check below already
     * answers, and `AuthContext` masks a wrong-role session down to exactly
     * that while it restores the right one.
     */
    const roleMatches = requiredRole === null || userType === null || userType === requiredRole;
    /**
     * What the page may actually send. Never the other role's token: a request
     * made with it can only come back 401/403, and the fix for that is the
     * sign-in redirect below, not the request.
     */
    const activeIdToken = isAuthenticated && roleMatches ? idToken : null;

    useEffect(() => {
        if (!enabled) return;
        if (isLoading) return;
        if (isAuthenticated && roleMatches) return;
        // The door for THIS page's role, never the one the browser's other
        // session happens to belong to.
        const dest = requiredRole ?? userType ?? 'worker';
        // With the page they were trying to reach, so signing in finishes
        // the journey instead of restarting it. `buildLoginUrl` drops
        // anything that is not a safe same-origin path (`sanitizeReturnPath`),
        // which is why the URL is built there and not here.
        nextRouter.replace(buildLoginUrl(locale, dest, currentReturnPath()));
    }, [enabled, isLoading, isAuthenticated, roleMatches, requiredRole, userType, nextRouter, locale]);

    const handleLegalWall = useCallback((err: unknown, returnUrl: string) => {
        if (isLegalWallError(err)) {
            sessionStorage.setItem('legalReturnUrl', returnUrl);
            router.replace('/legal/accept');
        } else {
            throw err;
        }
    }, [router]);

    return {
        handleLegalWall,
        /** This role's id token, or null. See `activeIdToken` above. */
        idToken: activeIdToken,
        /** Signed in AS THIS PAGE'S ROLE -- not merely signed in. */
        isAuthenticated: activeIdToken !== null,
        isLoading,
    };
}
