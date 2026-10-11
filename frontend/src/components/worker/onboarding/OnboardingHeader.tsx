'use client';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

/*
 * ===== BRAND SURFACE ==================================================
 * The navy band is the Jale brand mark, identical in both themes, for the
 * same reason `AuthShell` spells out at length: a worker meets the same brand
 * whatever their OS theme says, and a token that someone later re-tints under
 * `.dark` must not be able to repaint it. Hence the literal.
 *
 * The wordmark here is TEXT, not the image `AuthShell` uses: this band is
 * 12px tall on a phone with a language toggle beside it, and the approved
 * prototype draws a plain "Jale" at that size.
 */
const BRAND_NAVY = '#181855';

export type LanguageChoice = 'en' | 'es';

/**
 * Language is a header toggle here, never a step: the WhatsApp engine opens
 * with `start.choose_language`, but a worker who is already reading a Spanish
 * page has answered that question by arriving. Picking one both switches the
 * locale route AND writes `preferred_language`, which is what every later SMS
 * and WhatsApp message is sent in.
 *
 * With no `onSelect` (the loading skeleton) the buttons render inert rather
 * than vanishing, so the band does not change shape when the flow mounts.
 */
export function OnboardingHeader({
    onSelect,
    busy = false,
}: {
    onSelect?: (language: LanguageChoice) => void;
    busy?: boolean;
}) {
    const locale = useLocale();
    const t = useTranslations('worker_onboarding.header');
    const active: LanguageChoice = locale === 'es' ? 'es' : 'en';

    return (
        <div
            className="flex items-center justify-between px-[22px] pb-3 pt-3.5"
            style={{ backgroundColor: BRAND_NAVY }}
        >
            <span className="text-xl font-bold tracking-[-0.02em] text-white">Jale</span>
            <div role="group" aria-label={t('language_group')} className="inline-flex overflow-hidden rounded-full border border-white/30">
                {(['en', 'es'] as const).map((language) => (
                    <button
                        key={language}
                        type="button"
                        aria-pressed={active === language}
                        disabled={busy || !onSelect}
                        onClick={() => onSelect?.(language)}
                        className={[
                            'min-w-[44px] px-2.5 py-1 text-xs font-semibold tracking-[0.04em] transition-colors',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            'disabled:cursor-default',
                            active === language ? 'bg-white text-[#181855]' : 'bg-transparent text-white/80 hover:text-white',
                        ].join(' ')}
                    >
                        {t(language === 'en' ? 'language_en' : 'language_es')}
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * The card the whole flow lives in. Shared with `loading.tsx` so the skeleton
 * and the real screen are the same shape — the band and the progress rail must
 * not move when the data lands.
 */
export function OnboardingShell({
    onSelectLanguage,
    languageBusy,
    progress,
    children,
}: {
    onSelectLanguage?: (language: LanguageChoice) => void;
    languageBusy?: boolean;
    progress?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-screen justify-center bg-[var(--jale-paper)] sm:px-4 sm:py-6">
            <div className="flex w-full max-w-[520px] flex-col overflow-hidden bg-[var(--jale-card)] shadow-[var(--shadow-card)] sm:min-h-[700px] sm:rounded-[24px]">
                <OnboardingHeader onSelect={onSelectLanguage} busy={languageBusy} />
                {progress}
                <div className="flex flex-1 flex-col px-[22px] pb-[22px] pt-4">{children}</div>
            </div>
        </div>
    );
}
