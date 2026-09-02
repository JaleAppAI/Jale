'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import {
    answersForScreen,
    canContinue,
    customTradeAcceptable,
    MAX_CUSTOM_TRADE_CHARS,
    type OnboardingAnswerBatch,
    type OnboardingDraft,
} from '@/lib/onboarding-flow';
import { TRADE_KEYS, tradeLabelKey, type TradeKey } from '@/lib/worker-vocab';
import { OptionGrid } from './OptionGrid';
import { StepBody, StepField, StepFooter, StepHeader, StepHint, StepLayout, useRejectionMessage, type ExitLink } from './StepHeader';

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
    const tStepChrome = useTranslations('worker_onboarding.common');
    const rejectionMessage = useRejectionMessage();
    const fieldId = useId();

    const rejected = rejection && (rejection.stepKey === 'profile.trade' || rejection.stepKey === 'profile.custom_trade')
        ? rejectionMessage(rejection.reason, rejection.stepKey)
        : null;
    const errorId = `${fieldId}-error`;
    const hintId = `${fieldId}-hint`;
    const switchHintId = `${fieldId}-switch-hint`;
    // The server measures the trimmed text at 2..60 and answers `too_short` /
    // `too_long`. Saying it BEFORE the save turns a round trip into a sentence
    // that is already on screen -- and it is the same sentence either way.
    const outOfBounds = draft.trade === 'other'
        && draft.customTrade.length > 0
        && !customTradeAcceptable(draft.customTrade);
    const boundHint = outOfBounds
        ? rejectionMessage(
            draft.customTrade.trim().length > MAX_CUSTOM_TRADE_CHARS ? 'too_long' : 'too_short',
            'profile.custom_trade',
        )
        : null;
    // The one place Continue goes quiet with the screen fully filled in: the
    // engine is parked ON `profile.custom_trade` -- they picked Other on
    // WhatsApp and it is still waiting for the name -- and the worker has now
    // picked a STANDARD trade instead. That batch is one item BEHIND the
    // cursor, so `itemsFromCursor` filters it to nothing and `canContinue`
    // correctly says no. Without a sentence it just reads as a broken button.
    // Back is the honest control (it walks the engine off `custom_trade`),
    // gated on `onBack` actually being there -- pointing at a link that is
    // not rendered is worse than the silence. Staying on Other still posts
    // `profile.custom_trade` AT the cursor, so that case is excluded.
    const parkedOnCustomTrade = stepKey === 'profile.custom_trade'
        && draft.trade !== null
        && draft.trade !== 'other';
    const switchHint = parkedOnCustomTrade && onBack
        ? t('switch_from_custom_hint', { back: tStepChrome('back') })
        : null;

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
                            aria-invalid={rejected || outOfBounds ? true : undefined}
                            aria-describedby={rejected ? errorId : boundHint ? hintId : undefined}
                            onChange={(e) => onDraftChange({ customTrade: e.target.value })}
                        />
                        {!rejected && boundHint ? <span id={hintId}><StepHint>{boundHint}</StepHint></span> : null}
                    </StepField>
                ) : rejected ? (
                    <p id={errorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{rejected}</p>
                ) : null}
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                {/*
                  * Mounted unconditionally so the polite region EXISTS before
                  * the sentence lands in it -- a live region created in the
                  * same tick as its own first content is routinely not
                  * announced. It is also the Continue button's description:
                  * the button is disabled, so it takes no focus and a screen
                  * reader would otherwise never reach the one sentence that
                  * explains why it is dead.
                  */}
                <span id={switchHintId} aria-live="polite">
                    {switchHint ? <StepHint>{switchHint}</StepHint> : null}
                </span>
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    disabled={!canContinue('trade', draft, stepKey)}
                    aria-describedby={switchHint ? switchHintId : undefined}
                    onClick={() => onSubmit(answersForScreen('trade', draft, stepKey))}
                >
                    {t('cta')}
                </Button>
                {exitLink}
            </StepFooter>
        </StepLayout>
    );
}
