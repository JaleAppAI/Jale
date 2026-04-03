'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiFetch, LegalWallError } from '@/lib/api';

interface EmployerProfile {
    id: string;
    email: string;
    companyName: string | null;
}

export default function EmployerProfilePage() {
    const { idToken } = useAuth();
    useRequireAuth();
    const router = useRouter();
    const t = useTranslations('employer.profile');
    const tCommon = useTranslations('common');
    const [profile, setProfile] = useState<EmployerProfile | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!idToken) return;
        apiFetch('/employer/profile', {}, idToken)
            .then(async (res) => {
                if (!res.ok) throw new Error('fetch_failed');
                return res.json();
            })
            .then(setProfile)
            .catch((err) => {
                if (err instanceof LegalWallError) {
                    sessionStorage.setItem('legalReturnUrl', '/employer/profile');
                    router.replace('/legal/accept');
                } else {
                    setError(tCommon('error'));
                }
            });
    }, [idToken]);

    if (error) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-destructive">{error}</p></main>;
    if (!profile) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-muted-foreground">{tCommon('loading')}</p></main>;

    return (
        <main className="mx-auto max-w-5xl px-4 py-10">
            <h1 className="text-2xl font-semibold mb-6">{t('title')}</h1>
            <div className="rounded-lg border bg-card p-6 space-y-4">
                <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Email</p>
                    <p className="text-sm">{profile.email}</p>
                </div>
                {profile.companyName && (
                    <div>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Company</p>
                        <p className="text-sm">{profile.companyName}</p>
                    </div>
                )}
            </div>
        </main>
    );
}
