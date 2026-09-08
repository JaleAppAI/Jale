'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { assignReturnPath, sanitizeReturnPath } from '@/lib/login-url';
import EmployerAuthForm, { EmployerBrandPanel } from '@/components/auth/EmployerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

export const dynamic = 'force-dynamic';

export default function EmployerAuthPage() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    // Only an EMPLOYER session counts as signed in on this door. The provider
    // restores the employer slot alone on this route, but the guard is kept
    // explicit: with a worker signed in, this page shows the employer form
    // rather than sending them to the worker home -- both roles are meant to
    // coexist in one browser.
    const employerSignedIn = isAuthenticated && userType === 'employer';

    useEffect(() => {
        if (!isLoading && employerSignedIn) {
            // Where the visit came from: a session-expiry redirect, or the
            // sign-in gate on the page they actually wanted. Already
            // locale-prefixed, so it is assigned rather than routed --
            // router.replace() would add a second locale segment on top.
            const returnPath = sanitizeReturnPath(searchParams.get('returnUrl'));
            if (returnPath) {
                assignReturnPath(returnPath);
                return;
            }
            router.replace('/employer/dashboard');
        }
    }, [isLoading, employerSignedIn, router, searchParams]);

    // Not `return null`: that blanked the whole viewport between the route's
    // loading.tsx unmounting and the form mounting, and left an
    // already-signed-in user staring at nothing until the redirect above
    // landed. This markup is byte-identical to ./loading.tsx, so the shell
    // simply stays put and only the form column fills in.
    if (isLoading || employerSignedIn) {
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
