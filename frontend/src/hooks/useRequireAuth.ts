'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { LegalWallError } from '@/lib/api';

export function useRequireAuth() {
    const { isAuthenticated, userType } = useAuth();
    const router = useRouter();
    const locale = useLocale();

    useEffect(() => {
        if (!isAuthenticated) {
            const dest = userType === 'employer' ? 'employer' : 'worker';
            router.replace(`/${locale}/auth/${dest}`);
        }
    }, [isAuthenticated]);

    return {
        handleLegalWall: (err: unknown, returnUrl: string) => {
            if (err instanceof LegalWallError) {
                sessionStorage.setItem('legalReturnUrl', returnUrl);
                router.replace(`/${locale}/legal/accept`);
            } else {
                throw err;
            }
        }
    };
}
