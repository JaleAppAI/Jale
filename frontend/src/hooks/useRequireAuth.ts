'use client';
import { useCallback, useEffect } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { isLegalWallError } from '@/lib/api';

type UserType = 'worker' | 'employer';

function intendedUserType(pathname: string, userType: UserType | null): UserType {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return userType ?? 'worker';
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
    const pathname = usePathname();

    useEffect(() => {
        if (!enabled) return;
        if (isLoading) return;
        if (!isAuthenticated) {
            const dest = intendedUserType(pathname, userType);
            router.replace(`/auth/${dest}`);
        }
    }, [enabled, isLoading, isAuthenticated, pathname, userType, router]);

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
