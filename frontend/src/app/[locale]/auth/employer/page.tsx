'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { sanitizeReturnPath } from '@/lib/login-url';
import EmployerAuthForm, { EmployerBrandPanel } from '@/components/auth/EmployerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

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

    // Not `return null`: that blanked the whole viewport between the route's
    // loading.tsx unmounting and the form mounting, and left an
    // already-signed-in user staring at nothing until the redirect above
    // landed. This markup is byte-identical to ./loading.tsx, so the shell
    // simply stays put and only the form column fills in.
    if (isLoading || isAuthenticated) {
        return (
            <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
                <CenteredCardSkeleton title card={false} />
            </AuthShell>
        );
    }

    return (
        <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
            <EmployerAuthForm />
        </AuthShell>
    );
}
