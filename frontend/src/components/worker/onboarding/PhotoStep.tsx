'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StepBody, StepFooter, StepHeader, StepLayout } from './StepHeader';

/**
 * CLIENT-SIDE ONLY, AND SKIP-ONLY. This screen makes no request at all.
 *
 * Two separate facts put it here. First, the engine has no photo step: the run
 * completes on the third trust answer, and `profile.photo` is a key the API
 * answers 422 `unknown_step` for — so there is nothing to post. Second, there
 * is no profile-photo uploader in this app to reuse: the vault flow uploads
 * typed DOCUMENTS and the media board creates POSTS; an avatar is neither, and
 * would need its own field, upload type and moderation story.
 *
 * So the prompt is shown once, the upload is marked coming soon rather than
 * hidden (a worker who sent a photo on WhatsApp should see it is on its way
 * here too), and skipping is a local transition to the summary.
 */
export function PhotoStep({ onSkip }: { onSkip: () => void }) {
    const t = useTranslations('worker_onboarding.photo');
    const tShared = useTranslations('worker_onboarding.common');

    return (
        <StepLayout>
            {/* No Back: the run is already complete, and the engine's `back`
                endpoint only operates on an active run. */}
            <StepHeader screen="photo" title={t('title')} subtitle={t('subtitle')} onBack={null} />
            <StepBody>
                <div className="flex flex-col items-center text-center">
                    <div className="mx-auto mb-1.5 mt-3.5 grid h-[120px] w-[120px] place-items-center rounded-full border-2 border-dashed border-[var(--jale-divider)] bg-[var(--jale-input)] text-[var(--jale-ink-2)]">
                        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
                            <circle cx="12" cy="13" r="3.5" />
                        </svg>
                    </div>
                    <Button variant="ghost" size="lg" disabled title={tShared('coming_soon')} className="max-w-[240px]">
                        {t('add')}
                    </Button>
                </div>
            </StepBody>
            <StepFooter>
                <Button className="w-full" size="lg" onClick={onSkip}>{t('skip')}</Button>
            </StepFooter>
        </StepLayout>
    );
}
