'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { validateReturnTo } from '@/lib/referral-return';
import { claimReferral } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

export default function WorkerAuthPage() {
    const { isAuthenticated, isLoading, userType, idToken } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            if (userType === 'employer') {
                router.replace('/employer/dashboard');
                return;
            }
            const returnTo = validateReturnTo(searchParams.get('returnTo'));
            const shareCode = searchParams.get('share');
            const redirect = () => router.replace(returnTo ?? '/worker/home');

            // An already-authenticated worker never mounts WorkerAuthForm, so
            // this is the only place that can claim the referral for them.
            // Best-effort: a bad/expired code, or a missing idToken, must
            // never strand the user on this page -- always redirect after.
            if (shareCode && idToken) {
                claimReferral(idToken, shareCode).catch(() => {}).finally(redirect);
            } else {
                redirect();
            }
        }
    }, [isLoading, isAuthenticated, userType, router, searchParams, idToken]);

    if (isLoading || isAuthenticated) return null;

    return (
        <AuthShell variant="worker">
            <WorkerAuthForm />
        </AuthShell>
    );
}
