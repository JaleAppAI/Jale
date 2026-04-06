'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

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
            <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6">
                <div className="text-center space-y-4">
                    <p className="text-sm text-muted">{t('error_fetch')}</p>
                    <Button variant="outline" onClick={fetchTos}>{tCommon('retry')}</Button>
                </div>
            </main>
        );
    }

    if (!tosData) {
        return (
            <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
                <p className="text-sm text-muted">{tCommon('loading')}</p>
            </main>
        );
    }

    return (
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6">
            <Card className="w-full max-w-lg p-8 md:p-10 space-y-6">
                <div>
                    <h1 className="text-[1.15rem] font-semibold tracking-[-0.02em] leading-[1.45] mb-2">{t('title')}</h1>
                    <p className="text-sm text-muted">{t('body')}</p>
                </div>

                <div className="flex gap-4 text-sm">
                    <a href={tosData.tosUrl} target="_blank" rel="noopener noreferrer"
                        className="text-primary underline underline-offset-4 hover:text-primary-hover transition-colors duration-200 cursor-pointer">
                        {t('tos_link')}
                    </a>
                    <a href={tosData.privacyUrl} target="_blank" rel="noopener noreferrer"
                        className="text-primary underline underline-offset-4 hover:text-primary-hover transition-colors duration-200 cursor-pointer">
                        {t('privacy_link')}
                    </a>
                </div>

                <label className="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        id="legal-checkbox"
                        checked={checked}
                        onChange={(e) => setChecked(e.target.checked)}
                        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-primary"
                    />
                    <span className="text-sm">{t('checkbox')}</span>
                </label>

                {submitError && <p className="text-sm text-error">{t('error_submit')}</p>}

                <Button className="w-full" onClick={handleAccept} disabled={!checked || isSubmitting}>
                    {isSubmitting ? tCommon('loading') : t('accept_cta')}
                </Button>
            </Card>
        </main>
    );
}
