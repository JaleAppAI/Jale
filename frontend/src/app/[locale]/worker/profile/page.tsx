'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiFetch, LegalWallError } from '@/lib/api';

interface WorkerProfile {
    id: string;
    phone: string;
    name: string | null;
}

export default function WorkerProfilePage() {
    const { accessToken } = useAuth();
    useRequireAuth();
    const router = useRouter();
    const t = useTranslations('worker.profile');
    const tCommon = useTranslations('common');
    const [profile, setProfile] = useState<WorkerProfile | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!accessToken) return;
        apiFetch('/worker/profile', {}, accessToken)
            .then(async (res) => {
                if (!res.ok) throw new Error('fetch_failed');
                return res.json();
            })
            .then(setProfile)
            .catch((err) => {
                if (err instanceof LegalWallError) {
                    sessionStorage.setItem('legalReturnUrl', '/worker/profile');
                    router.replace('/legal/accept');
                } else {
                    setError(tCommon('error'));
                }
            });
    }, [accessToken]);

    if (error) return <p>{error}</p>;
    if (!profile) return <p>{tCommon('loading')}</p>;

    return (
        <main>
            <h1>{t('title')}</h1>
            {profile.name && <p>{profile.name}</p>}
            <p>{profile.phone}</p>
        </main>
    );
}
