'use client';
import { useCallback, useEffect } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { LegalWallError } from '@/lib/api';

type UserType = 'worker' | 'employer';

function intendedUserType(pathname: string, userType: UserType | null): UserType {
    if (pathname.includes('/employer')) return 'employer';
    if (pathname.includes('/worker')) return 'worker';
    return userType ?? 'worker';
}

export function useRequireAuth() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (isLoading) return;
        if (!isAuthenticated) {
            const dest = intendedUserType(pathname, userType);
            router.replace(`/auth/${dest}`);
        }
    }, [isLoading, isAuthenticated, pathname, userType, router]);

    const handleLegalWall = useCallback((err: unknown, returnUrl: string) => {
        if (err instanceof LegalWallError) {
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
