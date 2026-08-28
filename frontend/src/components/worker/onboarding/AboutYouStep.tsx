'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import {
    answersForScreen,
    canContinue,
    locationConfirmAnswer,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { LocationField } from './LocationField';
import { StepBody, StepField, StepFooter, StepHeader, StepHint, StepLayout, useRejectionMessage, type ExitLink } from './StepHeader';

/**
 * Name and location. Two name FIELDS, one `profile.name` VALUE: the engine
 * stores a single `full_name` (and the WhatsApp door asks for it as one line),
 * but a form that asks for "full name" gets "David" from half the people who
 * fill it in. The two boxes are joined with one space on the way out and split
 * back apart on resume.
 *
 * `pendingLocationConfirm` is the engine asking "did you mean San Antonio,
 * Texas?" after a fuzzy match. It replaces Continue with its own two buttons
 * rather than sitting beside it: there is exactly one thing to answer here,
 * and Continue would post a location step the engine is not waiting for.
 */
export function AboutYouStep({
    draft,
    stepKey,
    onDraftChange,
    pendingConfirm,
    rejection,
    saving,
    error,
    exitLink,
    onBack,
    onSubmit,
}: {
    draft: OnboardingDraft;
    /** The engine's cursor: decides which of this screen's two steps still need sending. */
    stepKey: string;
    onDraftChange: (patch: Partial<OnboardingDraft>) => void;
    pendingConfirm: { city: string; state: string } | null;
    rejection: { stepKey: string; reason: string } | null;
    saving: boolean;
    error?: string | null;
    exitLink?: ExitLink;
    onBack: (() => void) | null;
    onSubmit: (items: OnboardingAnswerBatch) => void;
}) {
    const t = useTranslations('worker_onboarding.about');
    const tCommon = useTranslations('common');
    const rejectionMessage = useRejectionMessage();
    const fieldId = useId();

    const nameError = rejection?.stepKey === 'profile.name' ? rejectionMessage(rejection.reason) : null;
    const locationError = rejection?.stepKey === 'profile.location' ? rejectionMessage(rejection.reason) : null;
    const nameErrorId = `${fieldId}-name-error`;
    const locationErrorId = `${fieldId}-location-error`;

    return (
        <StepLayout>
            <StepHeader screen="about" title={t('title')} subtitle={t('subtitle')} onBack={onBack} backDisabled={saving} />
            <StepBody>
                <div className="grid grid-cols-1 gap-2.5 min-[400px]:grid-cols-2">
                    <StepField label={t('first_name')} htmlFor={`${fieldId}-first`} error={nameError} errorId={nameErrorId}>
                        <Input
                            id={`${fieldId}-first`}
                            value={draft.firstName}
                            autoComplete="given-name"
                            disabled={saving}
                            aria-invalid={nameError ? true : undefined}
                            aria-describedby={nameError ? nameErrorId : undefined}
                            onChange={(e) => onDraftChange({ firstName: e.target.value })}
                        />
                    </StepField>
                    <StepField label={t('last_name')} htmlFor={`${fieldId}-last`}>
                        <Input
                            id={`${fieldId}-last`}
                            value={draft.lastName}
                            autoComplete="family-name"
                            disabled={saving}
                            onChange={(e) => onDraftChange({ lastName: e.target.value })}
                        />
                    </StepField>
                </div>

                {/* LocationPicker owns its own input, so this label is plain text
                    rather than a <label> pointing at nothing. */}
                <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('location')}</p>
                    <LocationField
                        value={draft.location}
                        disabled={saving}
                        invalid={locationError !== null}
                        describedBy={locationError ? locationErrorId : undefined}
                        placeholder={t('location_placeholder')}
                        onChange={(location) => onDraftChange({ location })}
                    />
                    {locationError
                        ? <p id={locationErrorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{locationError}</p>
                        : <StepHint>{t('location_help')}</StepHint>}
                </div>

                {pendingConfirm ? (
                    <div className="rounded-xl bg-[var(--jale-blue-50)] px-3.5 py-3">
                        <p className="mb-2.5 text-sm text-[var(--jale-ink)]">
                            {t('confirm_title', { city: pendingConfirm.city, state: pendingConfirm.state })}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={saving} onClick={() => onSubmit(locationConfirmAnswer(true))}>
                                {t('confirm_yes')}
                            </Button>
                            <Button size="sm" variant="outline" disabled={saving} onClick={() => onSubmit(locationConfirmAnswer(false))}>
                                {t('confirm_no')}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                {pendingConfirm ? null : (
                    <Button
                        className="w-full"
                        size="lg"
                        loading={saving}
                        loadingLabel={tCommon('loading')}
                        disabled={!canContinue('about', draft, stepKey)}
                        onClick={() => onSubmit(answersForScreen('about', draft, stepKey))}
                    >
                        {t('cta')}
                    </Button>
                )}
                {exitLink}
            </StepFooter>
        </StepLayout>
    );
}
