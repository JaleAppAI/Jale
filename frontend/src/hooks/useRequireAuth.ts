'use client';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { LegalWallError } from '@/lib/api';

export function useRequireAuth() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (isLoading) return;
        if (!isAuthenticated) {
            const dest = userType === 'employer' ? 'employer' : 'worker';
            router.replace(`/auth/${dest}`);
        }
    }, [isLoading, isAuthenticated, userType, router]);

    return {
        handleLegalWall: (err: unknown, returnUrl: string) => {
            if (err instanceof LegalWallError) {
                sessionStorage.setItem('legalReturnUrl', returnUrl);
                router.replace('/legal/accept');
            } else {
                throw err;
            }
        }
    };
}
