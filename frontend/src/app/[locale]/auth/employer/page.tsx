'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { sanitizeReturnPath } from '@/lib/login-url';
import EmployerAuthForm, { EmployerBrandPanel } from '@/components/auth/EmployerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';

export const dynamic = 'force-dynamic';

export default function EmployerAuthPage() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            // Where a session-expiry redirect wants us back. Already
            // locale-prefixed, so assign it directly: router.replace() would
            // add a second locale segment on top.
            const returnPath = sanitizeReturnPath(searchParams.get('returnUrl'));
            if (returnPath) {
                window.location.assign(returnPath);
                return;
            }
            router.replace(userType === 'worker' ? '/worker/home' : '/employer/dashboard');
        }
    }, [isLoading, isAuthenticated, userType, router, searchParams]);

    if (isLoading || isAuthenticated) return null;

    return (
        <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
            <EmployerAuthForm />
        </AuthShell>
    );
}
