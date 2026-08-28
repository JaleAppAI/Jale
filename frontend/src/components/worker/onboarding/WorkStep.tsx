'use client';
import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import {
    answersForScreen,
    canContinue,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import {
    AVAILABILITY_KEYS,
    EXPERIENCE_KEYS,
    TRANSPORT_KEYS,
    availabilityLabelKey,
    experienceLabelKey,
    transportLabelKey,
    type AvailabilityKey,
    type ExperienceKey,
    type TransportKey,
} from '@/lib/worker-vocab';
import { OptionGrid } from './OptionGrid';
import { StepBody, StepFooter, StepHeader, StepLayout, useRejectionMessage, type ExitLink } from './StepHeader';

/**
 * Three questions, ONE screen, one batch of three steps. The WhatsApp engine
 * asks them as three separate turns because a chat can only ask one thing at a
 * time; a form cannot, and making a worker tap Continue three times to answer
 * three two-word questions is the kind of thing that loses them at step six.
 *
 * Transportation is the reason `canContinue` checks `!== null` rather than
 * truthiness: "No" is an answer, and `false` must not read as "unanswered".
 */
export function WorkStep({
    draft,
    stepKey,
    onDraftChange,
    rejection,
    saving,
    error,
    exitLink,
    onBack,
    onSubmit,
}: {
    draft: OnboardingDraft;
    /**
     * The engine's cursor. This screen holds three engine steps, and a worker
     * resuming mid-way through them must only re-send the ones still ahead of
     * it -- the engine refuses a batch that starts behind where it is.
     */
    stepKey: string;
    onDraftChange: (patch: Partial<OnboardingDraft>) => void;
    rejection: { stepKey: string; reason: string } | null;
    saving: boolean;
    error?: string | null;
    exitLink?: ExitLink;
    onBack: (() => void) | null;
    onSubmit: (items: OnboardingAnswerBatch) => void;
}) {
    const t = useTranslations('worker_onboarding.work');
    const tVocab = useTranslations('worker_vocab');
    const tCommon = useTranslations('common');
    const rejectionMessage = useRejectionMessage();
    const groupId = useId();

    const rejected = rejection && rejection.stepKey.startsWith('profile.')
        ? rejectionMessage(rejection.reason)
        : null;
    const errorId = `${groupId}-error`;

    return (
        <StepLayout>
            <StepHeader screen="work" title={t('title')} onBack={onBack} backDisabled={saving} />
            <StepBody>
                <Group id={`${groupId}-years`} title={t('years')}>
                    <OptionGrid<ExperienceKey>
                        variant="grid"
                        labelledBy={`${groupId}-years`}
                        describedBy={rejected ? errorId : undefined}
                        options={EXPERIENCE_KEYS.map((key) => ({ value: key, label: tVocab(experienceLabelKey(key)) }))}
                        value={draft.experience}
                        disabled={saving}
                        onChange={(experience) => onDraftChange({ experience })}
                    />
                </Group>

                <Group id={`${groupId}-transport`} title={t('transport')}>
                    <OptionGrid<TransportKey>
                        variant="grid"
                        labelledBy={`${groupId}-transport`}
                        describedBy={rejected ? errorId : undefined}
                        options={TRANSPORT_KEYS.map((key) => ({ value: key, label: tVocab(transportLabelKey(key)) }))}
                        value={draft.transportation === null ? null : (draft.transportation ? 'yes' : 'no')}
                        disabled={saving}
                        onChange={(choice) => onDraftChange({ transportation: choice === 'yes' })}
                    />
                </Group>

                <Group id={`${groupId}-availability`} title={t('availability')}>
                    <OptionGrid<AvailabilityKey>
                        variant="grid"
                        labelledBy={`${groupId}-availability`}
                        describedBy={rejected ? errorId : undefined}
                        options={AVAILABILITY_KEYS.map((key) => ({ value: key, label: tVocab(availabilityLabelKey(key)) }))}
                        value={draft.availability}
                        disabled={saving}
                        onChange={(availability) => onDraftChange({ availability })}
                    />
                </Group>

                {rejected ? <p id={errorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{rejected}</p> : null}
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    disabled={!canContinue('work', draft, stepKey)}
                    onClick={() => onSubmit(answersForScreen('work', draft, stepKey))}
                >
                    {t('cta')}
                </Button>
                {exitLink}
            </StepFooter>
        </StepLayout>
    );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <h2 id={id} className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--jale-ink-2)]">{title}</h2>
            {children}
        </div>
    );
}
