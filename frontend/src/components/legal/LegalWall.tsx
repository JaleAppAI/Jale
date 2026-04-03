'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface TosData {
    version: string;
    tosUrl: string;
    privacyUrl: string;
}

export default function LegalWall() {
    const t = useTranslations('legal');
    const tCommon = useTranslations('common');
    const router = useRouter();
    const { idToken } = useAuth();

    const [tosData, setTosData] = useState<TosData | null>(null);
    const [checked, setChecked] = useState(false);
    const [fetchError, setFetchError] = useState(false);
    const [submitError, setSubmitError] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const fetchTos = async () => {
        if (!idToken) return;
        setFetchError(false);
        try {
            const res = await apiFetch('/legal/tos', {}, idToken);
            if (!res.ok) throw new Error('Failed to fetch');
            const data = await res.json();
            setTosData(data);
        } catch {
            setFetchError(true);
        }
    };

    useEffect(() => {
        fetchTos();
    }, [idToken]);

    const handleAccept = async () => {
        if (!tosData || !checked) return;
        setSubmitError(false);
        setIsSubmitting(true);
        try {
            const res = await apiFetch(
                '/legal/accept',
                { method: 'POST', body: JSON.stringify({ tosVersion: tosData.version }) },
                idToken ?? undefined
            );
            if (!res.ok) throw new Error('Failed to accept');
            const returnUrl = sessionStorage.getItem('legalReturnUrl') ?? '/';
            sessionStorage.removeItem('legalReturnUrl');
            router.replace(returnUrl);
        } catch {
            setSubmitError(true);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (fetchError) {
        return (
            <div>
                <p>{t('error_fetch')}</p>
                <Button onClick={fetchTos}>{tCommon('retry')}</Button>
            </div>
        );
    }

    if (!tosData) {
        return <p>{tCommon('loading')}</p>;
    }

    return (
        <div>
            <h1>{t('title')}</h1>
            <p>{t('body')}</p>

            <div>
                <a href={tosData.tosUrl} target="_blank" rel="noopener noreferrer">
                    {t('tos_link')}
                </a>
                <a href={tosData.privacyUrl} target="_blank" rel="noopener noreferrer">
                    {t('privacy_link')}
                </a>
            </div>

            <div>
                <input
                    type="checkbox"
                    id="legal-checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                />
                <label htmlFor="legal-checkbox">{t('checkbox')}</label>
            </div>

            {submitError && <p>{t('error_submit')}</p>}

            <Button onClick={handleAccept} disabled={!checked || isSubmitting}>
                {isSubmitting ? tCommon('loading') : t('accept_cta')}
            </Button>
        </div>
    );
}
