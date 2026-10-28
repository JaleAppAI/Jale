'use client';
import { useCallback, useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter as useNextRouter } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { isLegalWallError, isMembershipBlockedError } from '@/lib/api';
import { clearEmployerMembershipCache, membershipAccessPath } from '@/lib/employer-membership-store';
import { buildLoginUrl, currentReturnPath } from '@/lib/login-url';
import { locales } from '@/i18n/locales';

type UserType = 'worker' | 'employer';

/** The role a path is about, or null for one that is about neither. */
function roleFromPath(pathname: string): UserType | null {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return null;
}

/**
 * The two pages a blocked login has to be able to stay on: the access screen
 * itself, and the invite page (where a removed or orgless login rejoins).
 * Read from the address bar at the moment of the redirect (so
 * `handleLegalWall` keeps one identity across navigations), with its leading
 * locale stripped.
 */
function isBlockedLoginHome(pathname: string): boolean {
    const [, first, ...rest] = pathname.split('/');
    const path = (locales as readonly string[]).includes(first) ? `/${rest.join('/')}` : pathname;
    return path === '/employer/access' || path === '/employer/access/'
        || path === '/auth/employer/invite' || path.startsWith('/auth/employer/invite/');
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
        // With the page they were trying to reach (from the address bar, with
        // its locale: `currentReturnPath`), so signing in finishes
        // the journey instead of restarting it. `buildLoginUrl` drops
        // anything that is not a safe same-origin path (`sanitizeReturnPath`),
        // which is why the URL is built there and not here.
        nextRouter.replace(buildLoginUrl(locale, dest, currentReturnPath()));
    }, [enabled, isLoading, isAuthenticated, roleMatches, requiredRole, userType, nextRouter, locale]);

    /**
     * The walls a request can hit, each a redirect rather than a message:
     *   - the legal wall: accept the current terms, then come back;
     *   - a blocked company membership (Phase 3; `apiFetch` raises it only with
     *     the team flag on): the access screen for the reason, with `invite=1`
     *     when a re-invite is waiting. A 403 that named no status sends no
     *     reason, and the screen waits for its own membership read. The cached
     *     membership is dropped: it no longer describes this login. No return
     *     URL: there is nothing to come back to until the membership changes.
     *     Already on the access screen or the invite page, nothing happens:
     *     those are where a blocked login belongs, and the invite page is how
     *     it rejoins (Milestone C review, C1).
     * Anything else is re-thrown for the page to handle.
     */
    const handleLegalWall = useCallback((err: unknown, returnUrl: string) => {
        if (isLegalWallError(err)) {
            sessionStorage.setItem('legalReturnUrl', returnUrl);
            router.replace('/legal/accept');
        } else if (isMembershipBlockedError(err)) {
            if (isBlockedLoginHome(window.location.pathname)) return;
            clearEmployerMembershipCache();
            router.replace(membershipAccessPath(err));
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
