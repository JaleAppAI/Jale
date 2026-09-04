'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';
import { validateJobId, isAuthFlowCompleting } from '@/lib/referral-return';
import { assignReturnPath, sanitizeReturnPath } from '@/lib/login-url';
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
            // Where the visit came from: a session-expiry redirect, or the
            // sign-in gate on the page they actually wanted. Already
            // locale-prefixed, so it is assigned rather than routed --
            // router.replace() would add a second locale segment on top.
            const returnPath = sanitizeReturnPath(searchParams.get('returnUrl'));
            if (returnPath) {
                assignReturnPath(returnPath);
                return;
            }
            router.replace('/worker/home');
        }
    }, [isLoading, isAuthenticated, userType, router, searchParams, idToken]);

    // Not `return null`: that blanked the whole viewport between the route's
    // loading.tsx unmounting and the form mounting -- a navy-to-white-to-navy
    // flash on every visit, and a dead screen for as long as the redirect above
    // takes for an already-signed-in user. This markup is byte-identical to
    // ./loading.tsx, so the shell simply stays put and only the card fills in.
    if (isLoading || isAuthenticated) {
        return (
            <AuthShell variant="worker">
                <CenteredCardSkeleton title card={false} />
            </AuthShell>
        );
    }

    return (
        <AuthShell variant="worker">
            <WorkerAuthForm />
        </AuthShell>
    );
}
