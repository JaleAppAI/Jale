'use client';
import { useCallback, useEffect } from 'react';
import { useLocale } from 'next-intl';
import { useRouter as useNextRouter } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { isLegalWallError } from '@/lib/api';
import { buildLoginUrl } from '@/lib/login-url';

type UserType = 'worker' | 'employer';

function intendedUserType(pathname: string, userType: UserType | null): UserType {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return userType ?? 'worker';
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
};

export function useRequireAuth({ enabled = true }: UseRequireAuthOptions = {}) {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    // Two routers on purpose. `buildLoginUrl` returns an ALREADY
    // locale-prefixed path, so it goes through Next's own router; next-intl's
    // would prefix a second locale onto it (`/es/es/auth/worker`). The
    // locale-less `/legal/accept` hop below still wants the next-intl one.
    const nextRouter = useNextRouter();
    const locale = useLocale();
    const pathname = usePathname();

    useEffect(() => {
        if (!enabled) return;
        if (isLoading) return;
        if (!isAuthenticated) {
            const dest = intendedUserType(pathname, userType);
            // With the page they were trying to reach, so signing in finishes
            // the journey instead of restarting it. `buildLoginUrl` drops
            // anything that is not a safe same-origin path (`sanitizeReturnPath`),
            // which is why the URL is built there and not here.
            nextRouter.replace(buildLoginUrl(locale, dest, currentReturnPath()));
        }
    }, [enabled, isLoading, isAuthenticated, pathname, userType, nextRouter, locale]);

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
    };
}
