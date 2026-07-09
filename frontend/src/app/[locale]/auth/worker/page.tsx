'use client';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';
import { AuthShell } from '@/components/auth/AuthShell';

export const dynamic = 'force-dynamic';

export default function WorkerAuthPage() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            router.replace(userType === 'employer' ? '/employer/dashboard' : '/worker/home');
        }
    }, [isLoading, isAuthenticated, userType, router]);

    if (isLoading || isAuthenticated) return null;

    return (
        <AuthShell variant="worker">
            <WorkerAuthForm />
        </AuthShell>
    );
}
