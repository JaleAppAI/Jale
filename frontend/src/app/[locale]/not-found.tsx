'use client';

import { useTranslations } from 'next-intl';
import { StateAction } from '@/components/ui/empty-state';

/**
 * Branded 404 for the localized app.
 *
 * Rendered by `notFound()` from any route under `[locale]`, including the
 * catch-all segment that swallows URLs matching no real route. A client
 * component so the copy always resolves through the layout's
 * `NextIntlClientProvider` rather than depending on the server request locale
 * being in scope for a not-found render.
 */
export default function LocaleNotFound() {
    const t = useTranslations('common');

    return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--jale-paper)] px-4 py-12">
            <div className="mx-auto w-full max-w-sm text-center">
                <p className="jale-wordmark mb-6">Jale</p>

                <p className="text-base font-bold text-[var(--jale-ink)]">{t('not_found_page.title')}</p>
                <p className="mt-2 text-sm text-[var(--jale-ink-2)]">{t('not_found_page.body')}</p>

                <div className="mt-6 flex items-center justify-center">
                    <StateAction action={{ label: t('not_found_page.cta'), href: '/' }} tone="primary" />
                </div>
            </div>
        </div>
    );
}
