'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Textarea } from '@/components/ui/textarea';
import {
    MAX_ANSWER_CHARS,
    MIN_ANSWER_CHARS,
    answerAcceptable,
    answerLongEnough,
    answerTooLong,
    type OnboardingAnswerBatch,
} from '@/lib/onboarding-flow';
import { StepBody, StepFooter, StepHeader, StepLayout, useRejectionMessage, type ExitLink } from './StepHeader';

/**
 * One of the three answers employers actually read.
 *
 * The QUESTION is the page heading and the trade is a small eyebrow above it —
 * the inversion is the point. These are not form fields with labels; each one
 * is the only thing on its screen, and the worker should be reading a question
 * rather than filling in a box called "Answer 2".
 *
 * NO SKIP. The three answers are what separate a Jale profile from a phone
 * number, and a skipped one cannot be asked for again later in this flow. The
 * floor is `MIN_ANSWER_CHARS` of real text, with the shortfall spelled out
 * rather than left as a mysteriously dead button.
 *
 * ANSWERS STAY EDITABLE UNTIL THE THIRD IS SENT. Back walks the engine
 * (Q3 -> Q2 -> Q1), and the response to each `back` carries the answers
 * already stored, so `draftFromState` puts the earlier text straight back in
 * this box. Re-answering Q1 then advances forward through Q2 and Q3 with what
 * was written there still in place -- nothing is retyped to get past it.
 *
 * The mic is rendered DISABLED rather than hidden: voice answers ship in a
 * later release, and a worker who used them on WhatsApp should see that the
 * affordance exists here and is coming, not wonder whether the web lost it.
 */
export function TrustQuestionStep({
    index,
    question,
    tradeLabel,
    answer,
    source,
    onAnswerChange,
    rejection,
    saving,
    error,
    exitLink,
    onBack,
    onSubmit,
}: {
    index: 1 | 2 | 3;
    question: string;
    tradeLabel: string | null;
    answer: string;
    source: 'text' | 'voice';
    onAnswerChange: (text: string) => void;
    rejection: { stepKey: string; reason: string } | null;
    saving: boolean;
    error?: string | null;
    exitLink?: ExitLink;
    onBack: (() => void) | null;
    onSubmit: (items: OnboardingAnswerBatch) => void;
}) {
    const t = useTranslations('worker_onboarding.question');
    const tShared = useTranslations('worker_onboarding.common');
    const tTrust = useTranslations('worker_onboarding.trust');
    const tCommon = useTranslations('common');
    const rejectionMessage = useRejectionMessage();
    const fieldId = useId();

    const trimmed = answer.trim();
    // Both bounds are the SERVER's (15 / 2000, measured on the trimmed text).
    // Mirroring them here means the worker is stopped by a sentence rather
    // than by a 422 after they press Next.
    const ready = answerAcceptable(answer);
    const tooLong = answerTooLong(answer);
    const stepKey = `trust.question.${index}`;
    const rejected = rejection?.stepKey === stepKey ? rejectionMessage(rejection.reason, stepKey) : null;
    const errorId = `${fieldId}-error`;
    const hintId = `${fieldId}-hint`;

    return (
        <StepLayout>
            <StepHeader
                screen={(`q${index}`) as 'q1' | 'q2' | 'q3'}
                counterLabel={t('eyebrow', { number: index })}
                eyebrow={tradeLabel ?? undefined}
                title={question}
                subtitle={t('intro')}
                onBack={onBack}
                backDisabled={saving}
            />
            <StepBody>
                <div className="flex items-stretch gap-2.5">
                    <Textarea
                        id={`${fieldId}-answer`}
                        aria-label={question}
                        className="min-h-[150px] font-normal"
                        placeholder={t('placeholder')}
                        value={answer}
                        disabled={saving}
                        // Invalid only once the engine has actually refused it:
                        // an answer still being typed is short, not wrong.
                        aria-invalid={rejected || tooLong ? true : undefined}
                        aria-describedby={rejected ? errorId : hintId}
                        onChange={(e) => onAnswerChange(e.target.value)}
                    />
                    <button
                        type="button"
                        disabled
                        aria-label={t('mic_label')}
                        title={tShared('coming_soon')}
                        className="grid w-14 flex-none cursor-not-allowed place-items-center rounded-2xl border-[1.5px] border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-blue-500)] opacity-50"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="3" width="6" height="11" rx="3" />
                            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                        </svg>
                    </button>
                </div>

                <div className="flex items-center justify-between gap-2">
                    {source === 'voice' && !tooLong ? (
                        <span className="flex flex-1 items-center gap-2">
                            <span className="inline-block rounded-full bg-[var(--jale-input)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]">
                                {tShared('voice_badge')}
                            </span>
                            <span className="text-[13px] text-[var(--jale-ink-2)]">{t('voice_note')}</span>
                        </span>
                    ) : (
                        <span id={hintId} className="flex-1 text-[13px] text-[var(--jale-ink-2)]">
                            {tooLong
                                ? t('too_long', { count: MAX_ANSWER_CHARS })
                                : trimmed.length > 0 && !answerLongEnough(answer)
                                    ? t('too_short', { count: MIN_ANSWER_CHARS })
                                    : ''}
                        </span>
                    )}
                    <span className="text-xs tabular-nums text-[var(--jale-ink-2)]">
                        {t('chars', { count: trimmed.length })}
                    </span>
                </div>

                {rejected ? <p id={errorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{rejected}</p> : null}

                {index === 1 ? (
                    <p className="flex items-start gap-2 text-[13px] text-[var(--jale-ink-2)]">
                        <span aria-hidden="true" className="font-semibold text-[var(--jale-blue-700)]">●</span>
                        <span>{t('must')}</span>
                    </p>
                ) : null}
            </StepBody>
            <StepFooter>
                {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
                <Button
                    className="w-full"
                    size="lg"
                    loading={saving}
                    loadingLabel={tCommon('loading')}
                    disabled={!ready}
                    onClick={() => onSubmit([{ stepKey, value: { text: trimmed } }])}
                >
                    {index === 3 ? tTrust('complete_cta') : t('cta')}
                </Button>
                {/* The last question is the point of no return: it completes
                    the run, and the engine's `back` only walks an ACTIVE one.
                    Say so under the button rather than after it, while the
                    worker can still walk back and change an answer. */}
                {index === 3 ? (
                    <p className="text-center text-[13px] text-[var(--jale-ink-2)]">{tTrust('complete_note')}</p>
                ) : null}
                {exitLink}
            </StepFooter>
        </StepLayout>
    );
}
