'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { validateJobId, isAuthFlowCompleting } from '@/lib/referral-return';
import { sanitizeReturnPath } from '@/lib/login-url';
import { claimReferral } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

export default function WorkerAuthPage() {
    const { isAuthenticated, isLoading, userType, idToken } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            // WorkerAuthForm just finished its own OTP-success transition (it
            // owns the claim + redirect for that case) -- stand down so we
            // don't double-claim the referral and race it on the redirect.
            if (isAuthFlowCompleting()) return;

            if (userType === 'employer') {
                router.replace('/employer/dashboard');
                return;
            }

            // An already-authenticated worker never mounts WorkerAuthForm, so
            // this is the only place that can claim the referral for them.
            // Fire-and-forget: a bad/expired code, or a missing idToken,
            // must never delay or block the redirect.
            const jobId = validateJobId(searchParams.get('job'));
            const shareCode = searchParams.get('share');
            if (shareCode && idToken) {
                claimReferral(idToken, shareCode).catch(() => {});
            }
            if (jobId) {
                router.replace(`/worker/jobs/${jobId}`);
                return;
            }
            // Where a session-expiry redirect wants us back. Already
            // locale-prefixed, so assign it directly: router.replace() would
            // add a second locale segment on top.
            const returnPath = sanitizeReturnPath(searchParams.get('returnUrl'));
            if (returnPath) {
                window.location.assign(returnPath);
                return;
            }
            router.replace('/worker/home');
        }
    }, [isLoading, isAuthenticated, userType, router, searchParams, idToken]);

    if (isLoading || isAuthenticated) return null;

    return (
        <AuthShell variant="worker">
            <WorkerAuthForm />
        </AuthShell>
    );
}
