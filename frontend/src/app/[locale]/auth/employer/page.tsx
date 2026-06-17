'use client';
import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import EmployerAuthForm from '@/components/auth/EmployerAuthForm';

export const dynamic = 'force-dynamic';

export default function EmployerAuthPage() {
    const { isAuthenticated, isLoading, userType } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            router.replace(userType === 'worker' ? '/worker/home' : '/employer/dashboard');
        }
    }, [isLoading, isAuthenticated, userType, router]);

    if (isLoading || isAuthenticated) return null;

    return (
        <main className="flex flex-col items-center px-4">
            <EmployerAuthForm />
        </main>
    );
}
