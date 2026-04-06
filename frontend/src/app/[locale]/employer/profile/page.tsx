'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiFetch } from '@/lib/api';
import { Card } from '@/components/ui/card';

interface EmployerProfile {
    id: string;
    email: string;
    companyName: string | null;
}

export default function EmployerProfilePage() {
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
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
                try {
                    handleLegalWall(err, '/employer/profile');
                } catch {
                    setError(tCommon('error'));
                }
            });
    }, [idToken]);

    if (error) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error}</p></main>;
    if (!profile) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-muted">{tCommon('loading')}</p></main>;

    return (
        <main className="mx-auto max-w-5xl px-4 py-10">
            <h1 className="text-[1.4rem] md:text-[1.7rem] font-bold tracking-[-0.03em] leading-[1.2] mb-6">{t('title')}</h1>
            <Card className="p-6 space-y-4">
                <div>
                    <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('field_email')}</p>
                    <p className="text-sm">{profile.email}</p>
                </div>
                {profile.companyName && (
                    <div>
                        <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('field_company')}</p>
                        <p className="text-sm">{profile.companyName}</p>
                    </div>
                )}
            </Card>
        </main>
    );
}
