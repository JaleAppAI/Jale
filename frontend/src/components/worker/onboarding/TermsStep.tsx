'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { answersForScreen, type OnboardingAnswerBatch, type OnboardingDraft } from '@/lib/onboarding-flow';
import { StepBody, StepFooter, StepHeader, StepLayout } from './StepHeader';

/** The draft plays no part here — `legal.review` is answered with a constant. */
const NO_DRAFT = {} as OnboardingDraft;

/**
 * The legal read, as a STEP of onboarding rather than the app-wide legal wall.
 *
 * That is the whole reason this flow calls `apiFetch` directly instead of
 * going through `usePageData`: the wall's `legal_wall` classification bounces
 * a worker to `/legal/accept`, and bouncing them out of onboarding to accept
 * terms they are being shown right here would be a loop.
 */
export function TermsStep({
    saving,
    error,
    onSubmit,
}: {
    saving: boolean;
    error?: string | null;
    onSubmit: (items: OnboardingAnswerBatch) => void;
}) {
    const t = useTranslations('worker_onboarding.terms');
    const tCommon = useTranslations('common');

    return (
        <StepLayout>
            <StepHeader screen="terms" title={t('title')} subtitle={t('subtitle')} onBack={null} />
            <StepBody>
                <div className="max-h-[240px] overflow-auto rounded-[14px] border border-[var(--jale-divider)] px-4 py-3.5 text-sm font-light leading-relaxed text-[var(--jale-ink-2)]">
                    <h2 className="mb-1.5 text-sm font-semibold text-[var(--jale-ink)]">{t('info_title')}</h2>
                    <p className="mb-2.5">{t('info_body')}</p>
                    <h2 className="mb-1.5 text-sm font-semibold text-[var(--jale-ink)]">{t('messages_title')}</h2>
                    <p className="mb-2.5">{t('messages_body')}</p>
                    <h2 className="mb-1.5 text-sm font-semibold text-[var(--jale-ink)]">{t('terms_title')}</h2>
                    <p className="mb-0">{t('terms_body')}</p>
                </div>
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    onClick={() => onSubmit(answersForScreen('terms', NO_DRAFT))}
                >
                    {t('cta')}
                </Button>
            </StepFooter>
        </StepLayout>
    );
}
