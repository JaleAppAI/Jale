'use client';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import WorkerAuthForm from '@/components/auth/WorkerAuthForm';

export default function WorkerAuthPage() {
    const { isAuthenticated, isLoading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            router.replace('/worker/profile');
        }
    }, [isLoading, isAuthenticated]);

    if (isLoading || isAuthenticated) return null;

    return (
        <main className="flex min-h-screen flex-col items-center justify-center px-4">
            <WorkerAuthForm />
        </main>
    );
}
