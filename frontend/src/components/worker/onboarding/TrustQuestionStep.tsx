'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { pickRecordingMimeType, type VoiceAnswerOutcome } from '@/lib/onboarding-voice';
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
 * ── VOICE (S23 L6) ──────────────────────────────────────────────────────
 *
 * The mic RECORDS AND FILLS THE BOX. It does not answer the question. The
 * transcript lands in the same textarea the worker was already looking at, and
 * they read it, fix what was misheard, and press the same button a typed
 * answer presses. Dictation over a running compressor is not accurate enough
 * to commit unseen, and there is no second chance at a trust answer.
 *
 * TEXT STAYS PRIMARY, ALWAYS. Every failure — no MediaRecorder, a denied
 * microphone, silence, a transcription that timed out — leaves the textarea
 * exactly as it was and says one sentence about what happened. The mic is an
 * accelerator; it is never the only way through this screen. `onRecord` is
 * optional for the same reason: a caller that does not supply it gets the
 * disabled affordance, not a broken one.
 */
export function TrustQuestionStep({
    index,
    question,
    tradeLabel,
    answer,
    source,
    onAnswerChange,
    onRecord,
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
    /** Recording -> transcript. Absent means voice is not wired up here. */
    onRecord?: (blob: Blob, contentType: string) => Promise<VoiceAnswerOutcome>;
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
    const tVoice = useTranslations('worker_onboarding.trust.voice');
    const tCommon = useTranslations('common');
    const rejectionMessage = useRejectionMessage();
    const fieldId = useId();

    // ── Voice state ────────────────────────────────────────────────────
    type Phase = 'idle' | 'recording' | 'uploading' | 'transcribing';
    const [phase, setPhase] = useState<Phase>('idle');
    const [voiceError, setVoiceError] = useState<string | null>(null);
    /** The exact text the last transcript put in the box. Once the worker edits
     * it, the answer is theirs again and the badge must stop claiming a voice
     * note that no longer matches what is on screen. */
    const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const liveRef = useRef(true);

    // Resolved once: `MediaRecorder` is a browser capability, and asking on
    // every render would run the codec probe on every keystroke.
    const [recordMime] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        if (typeof MediaRecorder === 'undefined') return null;
        return pickRecordingMimeType();
    });

    const releaseStream = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];
    }, []);

    useEffect(() => {
        liveRef.current = true;
        return () => {
            // An unmount mid-recording (Back, a language switch, a route
            // change) must not leave the browser's recording indicator on.
            liveRef.current = false;
            try { recorderRef.current?.stop(); } catch { /* already stopped */ }
            releaseStream();
        };
    }, [releaseStream]);

    const canRecord = Boolean(onRecord) && recordMime !== null;
    const busy = phase === 'uploading' || phase === 'transcribing';

    async function handleRecorded(blob: Blob): Promise<void> {
        if (!onRecord || !recordMime) return;
        setPhase('transcribing');
        let outcome: VoiceAnswerOutcome;
        try {
            outcome = await onRecord(blob, recordMime);
        } catch {
            outcome = { kind: 'failed' };
        }
        if (!liveRef.current) return;
        setPhase('idle');

        if (outcome.kind === 'transcribed') {
            setVoiceDraft(outcome.transcript);
            onAnswerChange(outcome.transcript);
            return;
        }
        const key = outcome.kind === 'rejected'
            ? (outcome.reason === 'file_too_large' ? 'too_long' : 'failed')
            : outcome.kind === 'unusable' ? 'no_speech'
                : outcome.kind === 'timeout' ? 'timeout'
                    : outcome.kind === 'conflict' ? 'conflict'
                        : 'failed';
        setVoiceError(tVoice(key));
    }

    async function startRecording(): Promise<void> {
        setVoiceError(null);
        if (!recordMime) return;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            // Denied, dismissed, or no microphone at all — one sentence, and
            // the textarea is still right there.
            setVoiceError(tVoice('denied'));
            return;
        }
        if (!liveRef.current) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        streamRef.current = stream;
        chunksRef.current = [];
        let recorder: MediaRecorder;
        try {
            recorder = new MediaRecorder(stream, { mimeType: recordMime });
        } catch {
            releaseStream();
            setVoiceError(tVoice('failed'));
            return;
        }
        recorderRef.current = recorder;
        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => {
            const chunks = chunksRef.current;
            releaseStream();
            if (!liveRef.current) return;
            // `phase` is set by handleRecorded; a stop with nothing captured is
            // a tap-and-release, not an error worth a sentence.
            if (chunks.length === 0) { setPhase('idle'); return; }
            void handleRecorded(new Blob(chunks, { type: recordMime }));
        };
        recorder.start();
        setPhase('recording');
    }

    function stopRecording(): void {
        // Straight to `uploading`: the browser fires `onstop` asynchronously
        // and the worker must not see the button offer to record again in the
        // gap.
        setPhase('uploading');
        try { recorderRef.current?.stop(); } catch { setPhase('idle'); releaseStream(); }
    }

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
    const statusId = `${fieldId}-voice-status`;

    // A dictated answer the worker has not touched since. Editing it makes it
    // theirs, and the badge (and the `source` we post) follows the text.
    const isVoice = source === 'voice' || (voiceDraft !== null && voiceDraft === answer);

    const micLabel = phase === 'recording' ? tVoice('stop') : (canRecord ? tVoice('start') : t('mic_label'));
    const micTitle = onRecord
        ? (canRecord ? undefined : tVoice('unsupported'))
        : tShared('coming_soon');
    const statusText = phase === 'recording' ? tVoice('recording')
        : phase === 'uploading' ? tVoice('uploading')
            : phase === 'transcribing' ? tVoice('transcribing')
                : null;

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
                        // NOT disabled while a transcription runs: typing is
                        // the primary path and must never be taken away by the
                        // accelerator. The transcript replaces what is in the
                        // box when it lands — which is what pressing the mic
                        // asked for.
                        disabled={saving}
                        // Invalid only once the engine has actually refused it:
                        // an answer still being typed is short, not wrong.
                        aria-invalid={rejected || tooLong ? true : undefined}
                        aria-describedby={rejected ? errorId : hintId}
                        onChange={(e) => onAnswerChange(e.target.value)}
                    />
                    <button
                        type="button"
                        disabled={!canRecord || saving || busy}
                        aria-label={micLabel}
                        aria-pressed={canRecord ? phase === 'recording' : undefined}
                        aria-describedby={statusText ? statusId : undefined}
                        title={micTitle}
                        onClick={() => {
                            if (phase === 'recording') { stopRecording(); return; }
                            void startRecording();
                        }}
                        className={[
                            'grid w-14 flex-none place-items-center rounded-2xl border-[1.5px]',
                            'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-blue-500)]',
                            canRecord && !saving && !busy
                                ? 'cursor-pointer hover:bg-[var(--jale-input)]'
                                : 'cursor-not-allowed opacity-50',
                            phase === 'recording'
                                ? 'animate-pulse border-[var(--jale-danger)] text-[var(--jale-danger)]'
                                : '',
                        ].join(' ')}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="3" width="6" height="11" rx="3" />
                            <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                        </svg>
                    </button>
                </div>

                {/* One live region for the whole recording lifecycle: a worker
                    using a screen reader hears "recording", "sending",
                    "writing down what you said" without leaving the field. */}
                <p id={statusId} role="status" aria-live="polite" className="min-h-0 text-[13px] text-[var(--jale-ink-2)]">
                    {statusText ?? ''}
                </p>

                {voiceError ? (
                    <p role="alert" className="text-[13px] font-semibold text-[var(--jale-danger)]">{voiceError}</p>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                    {isVoice && !tooLong ? (
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
                    disabled={!ready || busy}
                    onClick={() => onSubmit([{
                        stepKey,
                        // `source` is the ONLY thing that tells the engine this
                        // text was dictated; it is recorded on the assessment
                        // row and never changes how the answer is handled.
                        value: { text: trimmed, ...(isVoice ? { source: 'voice' } : {}) },
                    }])}
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
