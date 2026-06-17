'use client';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';

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
        <main className="flex min-h-screen flex-col items-center justify-center px-4">
            <WorkerAuthForm />
        </main>
    );
}
