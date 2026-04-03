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

    if (error) return <p>{error}</p>;
    if (!profile) return <p>{tCommon('loading')}</p>;

    return (
        <main>
            <h1>{t('title')}</h1>
            {profile.companyName && <p>{profile.companyName}</p>}
            <p>{profile.email}</p>
        </main>
    );
}
