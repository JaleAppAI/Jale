'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { answersForScreen, type OnboardingAnswerBatch, type OnboardingDraft } from '@/lib/onboarding-flow';
import { StepBody, StepFooter, StepHeader, StepLayout } from './StepHeader';

/** `profile.photo` is answered with a constant; the draft has nothing to give. */
const NO_DRAFT = {} as OnboardingDraft;

/**
 * SKIP-ONLY IN V1, and the button says so by being disabled rather than absent.
 *
 * There is no profile-photo uploader in this app to reuse: the vault flow
 * (`getAuthUploadUrl`/`confirmAuthUpload`) uploads typed DOCUMENTS into a
 * worker's document vault, and the media board's uploader creates POSTS — a
 * profile avatar is neither, and would need its own backend field, its own
 * upload type and its own moderation story. Rather than half-wire one of those
 * two into an "avatar", the step is honest: the prompt is here, the upload is
 * marked coming soon, and skipping answers the engine's step so the run
 * completes.
 */
export function PhotoStep({
    saving,
    error,
    onBack,
    onSubmit,
}: {
    saving: boolean;
    error?: string | null;
    onBack: (() => void) | null;
    onSubmit: (items: OnboardingAnswerBatch) => void;
}) {
    const t = useTranslations('worker_onboarding.photo');
    const tShared = useTranslations('worker_onboarding.common');
    const tCommon = useTranslations('common');

    return (
        <StepLayout>
            <StepHeader screen="photo" title={t('title')} subtitle={t('subtitle')} onBack={onBack} backDisabled={saving} />
            <StepBody>
                <div className="flex flex-col items-center text-center">
                    <div className="mx-auto mb-1.5 mt-3.5 grid h-[120px] w-[120px] place-items-center rounded-full border-2 border-dashed border-[var(--jale-divider)] bg-[var(--jale-input)] text-[var(--jale-ink-2)]">
                        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                            <circle cx="12" cy="13" r="3.5" />
                        </svg>
                    </div>
                    <Button
                        variant="ghost"
                        size="lg"
                        disabled
                        title={tShared('coming_soon')}
                        className="max-w-[240px]"
                    >
                        {t('add')}
                    </Button>
                </div>
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    onClick={() => onSubmit(answersForScreen('photo', NO_DRAFT))}
                >
                    {t('skip')}
                </Button>
            </StepFooter>
        </StepLayout>
    );
}
