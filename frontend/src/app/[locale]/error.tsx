'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StateAction } from '@/components/ui/empty-state';

/**
 * Route error boundary for every localized page.
 *
 * Without this, an uncaught render/data error anywhere under `[locale]` falls
 * through to Next's default boundary -- a dead white page with no branding, no
 * translation and no way back. This catches it inside the locale layout, so the
 * intl provider is available and the copy is the same reviewed, bilingual
 * wording every other failure in the app uses.
 *
 * `error` is intentionally not rendered: it is an exception message, which is
 * neither translated nor safe to show. `errors.unknown` is the honest sentence
 * for "we do not know what happened".
 */
export default function LocaleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    const t = useTranslations('common');

    return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--jale-paper)] px-4 py-12">
            <div role="alert" className="mx-auto w-full max-w-sm text-center">
                <p className="jale-wordmark mb-6">Jale</p>

                <p className="text-base font-bold text-[var(--jale-ink)]">{t('error_state.title')}</p>
                <p className="mt-2 text-sm text-[var(--jale-ink-2)]">{t('errors.unknown')}</p>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                    <Button variant="primary" onClick={reset}>
                        {t('retry')}
                    </Button>
                    <StateAction action={{ label: t('error_state.go_home'), href: '/' }} tone="ghost" />
                </div>
            </div>
        </div>
    );
}
