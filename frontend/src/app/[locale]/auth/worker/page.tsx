'use client';
import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';
import { validateReturnTo } from '@/lib/referral-return';

export const dynamic = 'force-dynamic';

export default function WorkerAuthPage() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            if (userType === 'employer') {
                router.replace('/employer/dashboard');
                return;
            }
            const returnTo = validateReturnTo(searchParams.get('returnTo'));
            router.replace(returnTo ?? '/worker/home');
        }
    }, [isLoading, isAuthenticated, userType, router, searchParams]);

    if (isLoading || isAuthenticated) return null;

    return (
        <AuthShell variant="worker">
            <WorkerAuthForm />
        </AuthShell>
    );
}
