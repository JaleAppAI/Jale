'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import {
    answersForScreen,
    canContinue,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { TRADE_KEYS, tradeLabelKey, type TradeKey } from '@/lib/worker-vocab';
import { OptionGrid } from './OptionGrid';
import { StepBody, StepField, StepFooter, StepHeader, StepLayout, useRejectionMessage, type ExitLink } from './StepHeader';

/**
 * The five standard trades and Other, in the vocabulary's own order — which
 * puts `other` last without this screen having to know that. Picking Other
 * opens a free-text box; the two are posted as one batch so the engine never
 * sees `other` with no name attached.
 */
export function TradeStep({
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
     * The engine's cursor. A run already ON `profile.custom_trade` has the
     * trade itself behind it: switching to a standard trade here cannot be
     * expressed as a batch, so Continue goes quiet and Back is the way.
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
    const t = useTranslations('worker_onboarding.trade');
    const tVocab = useTranslations('worker_vocab');
    const tCommon = useTranslations('common');
    const rejectionMessage = useRejectionMessage();
    const fieldId = useId();

    const rejected = rejection && (rejection.stepKey === 'profile.trade' || rejection.stepKey === 'profile.custom_trade')
        ? rejectionMessage(rejection.reason)
        : null;
    const errorId = `${fieldId}-error`;

    return (
        <StepLayout>
            <StepHeader screen="trade" title={t('title')} subtitle={t('subtitle')} onBack={onBack} backDisabled={saving} />
            <StepBody>
                <OptionGrid<TradeKey>
                    options={TRADE_KEYS.map((key) => ({ value: key, label: tVocab(tradeLabelKey(key)) }))}
                    value={draft.trade}
                    disabled={saving}
                    describedBy={rejected ? errorId : undefined}
                    onChange={(trade) => onDraftChange({ trade })}
                />
                {draft.trade === 'other' ? (
                    <StepField label={t('other_label')} htmlFor={`${fieldId}-other`} error={rejected} errorId={errorId}>
                        <Input
                            id={`${fieldId}-other`}
                            value={draft.customTrade}
                            placeholder={t('other_placeholder')}
                            disabled={saving}
                            aria-invalid={rejected ? true : undefined}
                            aria-describedby={rejected ? errorId : undefined}
                            onChange={(e) => onDraftChange({ customTrade: e.target.value })}
                        />
                    </StepField>
                ) : rejected ? (
                    <p id={errorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{rejected}</p>
                ) : null}
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    disabled={!canContinue('trade', draft, stepKey)}
                    onClick={() => onSubmit(answersForScreen('trade', draft, stepKey))}
                >
                    {t('cta')}
                </Button>
                {exitLink}
            </StepFooter>
        </StepLayout>
    );
}
