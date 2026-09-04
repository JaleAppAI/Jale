// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrustQuestionStep } from '@/components/worker/onboarding/TrustQuestionStep';
import { MAX_ANSWER_CHARS, MIN_ANSWER_CHARS } from '@/lib/onboarding-flow';
import { interpolate, message, renderIntl } from './render-intl';

const LONG_ENOUGH = 'I frame houses and set trusses.';

function props(overrides: Partial<Parameters<typeof TrustQuestionStep>[0]> = {}) {
    return {
        index: 1 as 1 | 2 | 3,
        question: 'What do you do on a typical day?',
        tradeLabel: 'Carpenter',
        answer: '',
        source: 'text' as const,
        onAnswerChange: vi.fn(),
        rejection: null,
        saving: false,
        error: null,
        onBack: vi.fn(),
        onSubmit: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof TrustQuestionStep>[0];
}

describe('TrustQuestionStep', () => {
    it('makes the question the page heading and the trade an eyebrow', () => {
        renderIntl(<TrustQuestionStep {...props()} />);
        expect(screen.getByRole('heading', { name: 'What do you do on a typical day?' })).toBeInTheDocument();
        expect(screen.getByText('Carpenter')).toBeInTheDocument();
        expect(screen.getByText(interpolate(message('worker_onboarding.question.eyebrow'), { number: 1 }))).toBeInTheDocument();
    });

    it('renders its chrome in Spanish', () => {
        renderIntl(<TrustQuestionStep {...props({ question: '¿Qué haces en un día típico?' })} />, 'es');
        expect(screen.getByRole('heading', { name: '¿Qué haces en un día típico?' })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.question.intro', 'es'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.question.cta', 'es') })).toBeInTheDocument();
    });

    it('carries the "employers read these" note on question 1 only', () => {
        const { unmount } = renderIntl(<TrustQuestionStep {...props({ index: 1 })} />);
        expect(screen.getByText(message('worker_onboarding.question.must'))).toBeInTheDocument();
        unmount();

        renderIntl(<TrustQuestionStep {...props({ index: 2 })} />);
        expect(screen.queryByText(message('worker_onboarding.question.must'))).not.toBeInTheDocument();
    });

    it('offers no skip', () => {
        renderIntl(<TrustQuestionStep {...props()} />);
        expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();
    });

    it('keeps Next disabled under 15 characters and says how much more is needed', () => {
        const { rerender } = renderIntl(<TrustQuestionStep {...props({ answer: 'too short' })} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.question.cta') })).toBeDisabled();
        expect(screen.getByText(interpolate(
            message('worker_onboarding.question.too_short'),
            { count: MIN_ANSWER_CHARS },
        ))).toBeInTheDocument();

        rerender(<TrustQuestionStep {...props({ answer: LONG_ENOUGH })} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.question.cta') })).toBeEnabled();
    });

    it('stops an answer over the server ceiling before it can be rejected', () => {
        const tooLong = 'x'.repeat(MAX_ANSWER_CHARS + 1);
        renderIntl(<TrustQuestionStep {...props({ answer: tooLong })} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.question.cta') })).toBeDisabled();
        expect(screen.getByText(interpolate(
            message('worker_onboarding.question.too_long'),
            { count: MAX_ANSWER_CHARS },
        ))).toBeInTheDocument();
    });

    it('renders the two server-side length reasons as sentences, not codes', () => {
        renderIntl(<TrustQuestionStep {...props({
            answer: 'anything at all here',
            rejection: { stepKey: 'trust.question.1', reason: 'too_short' },
        })} />);
        expect(screen.getByRole('alert')).toHaveTextContent(interpolate(
            message('worker_onboarding.rejection.reason.too_short'),
            { min: MIN_ANSWER_CHARS },
        ));
    });

    it('counts characters', () => {
        renderIntl(<TrustQuestionStep {...props({ answer: LONG_ENOUGH })} />);
        expect(screen.getByText(interpolate(
            message('worker_onboarding.question.chars'),
            { count: LONG_ENOUGH.length },
        ))).toBeInTheDocument();
    });

    // A caller that does not wire voice up (this default props object) gets the
    // affordance disabled with the coming-soon tooltip, not a mic that breaks.
    it('shows the mic disabled with the coming-soon tooltip when no recorder is wired up', () => {
        renderIntl(<TrustQuestionStep {...props()} />);
        const mic = screen.getByRole('button', { name: message('worker_onboarding.question.mic_label') });
        expect(mic).toBeDisabled();
        expect(mic).toHaveAttribute('title', message('worker_onboarding.common.coming_soon'));
    });

    it('badges an answer that arrived as a voice note', () => {
        renderIntl(<TrustQuestionStep {...props({ answer: LONG_ENOUGH, source: 'voice' })} />);
        expect(screen.getByText(message('worker_onboarding.common.voice_badge'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.question.voice_note'))).toBeInTheDocument();
    });

    it('posts its own trust step, trimmed', async () => {
        const onSubmit = vi.fn();
        renderIntl(<TrustQuestionStep {...props({ index: 2, answer: `  ${LONG_ENOUGH}  `, onSubmit })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([{ stepKey: 'trust.question.2', value: { text: LONG_ENOUGH } }]);
    });

    // A saved answer the server already knows came from a voice note keeps its
    // provenance when it is re-submitted unchanged (Back, then forward again).
    it('re-posts a saved voice answer as voice', async () => {
        const onSubmit = vi.fn();
        renderIntl(<TrustQuestionStep {...props({ answer: LONG_ENOUGH, source: 'voice', onSubmit })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'trust.question.1', value: { text: LONG_ENOUGH, source: 'voice' } },
        ]);
    });

    it('names the last button for what it does, and warns that it is final', () => {
        // Luis, 2026-08-29: the third answer completes the run, so the button
        // stops being a "next" and says so before it is pressed.
        renderIntl(<TrustQuestionStep {...props({ index: 3, answer: LONG_ENOUGH })} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.trust.complete_cta') })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('worker_onboarding.question.cta') })).not.toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.trust.complete_note'))).toBeInTheDocument();
    });

    it('warns only on the last one — the first two are still changeable', () => {
        const { rerender } = renderIntl(<TrustQuestionStep {...props({ index: 1, answer: LONG_ENOUGH })} />);
        expect(screen.queryByText(message('worker_onboarding.trust.complete_note'))).not.toBeInTheDocument();
        rerender(<TrustQuestionStep {...props({ index: 2, answer: LONG_ENOUGH })} />);
        expect(screen.queryByText(message('worker_onboarding.trust.complete_note'))).not.toBeInTheDocument();
    });

    it('says both in Spanish', () => {
        renderIntl(<TrustQuestionStep {...props({ index: 3, answer: LONG_ENOUGH })} />, 'es');
        expect(screen.getByRole('button', { name: message('worker_onboarding.trust.complete_cta', 'es') })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.trust.complete_note', 'es'))).toBeInTheDocument();
    });

    // Luis, S24: "you won't be able to change your answers" was a grey 13px
    // line UNDER the button — the same weight as every hint on the flow, and
    // read after the press it was meant to inform. It is the one irreversible
    // moment in onboarding, so it is a bordered callout with an icon, above
    // the CTA, exposed as a `note` landmark. The COPY is unchanged.
    it('raises the final warning as a callout above the CTA, not a hint under it', () => {
        renderIntl(<TrustQuestionStep {...props({ index: 3, answer: LONG_ENOUGH })} />);
        const callout = screen.getByRole('note');
        expect(callout).toHaveTextContent(message('worker_onboarding.trust.complete_note'));
        // The icon is decorative and must not be announced as content.
        expect(callout.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        const cta = screen.getByRole('button', { name: message('worker_onboarding.trust.complete_cta') });
        // Exactly FOLLOWING: the CTA comes after the callout and neither
        // contains the other (containment would add its own flags), so the
        // warning cannot slide back under the button unnoticed.
        expect(callout.compareDocumentPosition(cta)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('raises no such callout while the answers are still changeable', () => {
        const { rerender } = renderIntl(<TrustQuestionStep {...props({ index: 1, answer: LONG_ENOUGH })} />);
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
        rerender(<TrustQuestionStep {...props({ index: 2, answer: LONG_ENOUGH })} />);
        expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('focuses the answer box on arrival so the worker can type straight away', () => {
        renderIntl(<TrustQuestionStep {...props()} />);
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'))).toHaveFocus();
    });

    it('types through the answer callback', async () => {
        const onAnswerChange = vi.fn();
        renderIntl(<TrustQuestionStep {...props({ onAnswerChange })} />);
        await userEvent.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), 'I');
        expect(onAnswerChange).toHaveBeenCalledWith('I');
    });
});

// ── S23 L6: the mic ─────────────────────────────────────────────────────
//
// `MediaRecorder` and `getUserMedia` do not exist in jsdom, so both are
// installed per test — which is also how the two fallback paths are tested:
// one WITHOUT MediaRecorder at all, one where the permission prompt is
// refused. In both, typing must still be available and the textarea untouched.

function installMediaRecorder(options: { supported?: string[] } = {}) {
    const supported = options.supported ?? ['audio/webm;codecs=opus', 'audio/webm'];
    class FakeMediaRecorder {
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start = vi.fn();
        mimeType: string;
        constructor(_stream: unknown, opts: { mimeType: string }) {
            this.mimeType = opts.mimeType;
        }
        /** Synchronous, unlike the real one — the component must not depend on
         * the gap, and a test that awaited it would be testing jsdom. */
        stop() {
            this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
            this.onstop?.();
        }
        static isTypeSupported(type: string) { return supported.includes(type); }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
}

function installMicrophone(result: 'granted' | 'denied' = 'granted') {
    const track = { stop: vi.fn() };
    vi.stubGlobal('navigator', Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, {
        mediaDevices: {
            getUserMedia: result === 'granted'
                ? vi.fn().mockResolvedValue({ getTracks: () => [track] })
                : vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
        },
    }));
    return track;
}

const TRANSCRIPT = 'I frame houses and set trusses on residential remodels.';

describe('TrustQuestionStep — voice answers', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function record(onRecord: ReturnType<typeof vi.fn>, extra = {}) {
        const view = renderIntl(<TrustQuestionStep {...props({ onRecord, ...extra })} />);
        const mic = screen.getByRole('button', { name: message('worker_onboarding.trust.voice.start') });
        await userEvent.click(mic);
        return { view, mic };
    }

    it('records, transcribes and puts the text in the box for the worker to review', async () => {
        installMediaRecorder();
        installMicrophone();
        const onAnswerChange = vi.fn();
        const onRecord = vi.fn().mockResolvedValue({ kind: 'transcribed', transcript: TRANSCRIPT });

        await record(onRecord, { onAnswerChange });

        // Recording: the button now offers to STOP, and says so out loud.
        expect(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') })).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent(message('worker_onboarding.trust.voice.recording'));

        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        expect(onRecord).toHaveBeenCalledTimes(1);
        const [blob, contentType] = onRecord.mock.calls[0];
        expect(blob).toBeInstanceOf(Blob);
        expect(contentType).toBe('audio/webm;codecs=opus');
        // The transcript is HANDED BACK, never submitted on the worker's behalf.
        expect(onAnswerChange).toHaveBeenCalledWith(TRANSCRIPT);
    });

    it('submits a reviewed transcript with source:voice, and drops it once edited', async () => {
        installMediaRecorder();
        installMicrophone();
        const onSubmit = vi.fn();
        const onRecord = vi.fn().mockResolvedValue({ kind: 'transcribed', transcript: TRANSCRIPT });

        const { view } = await record(onRecord, { onSubmit });
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        // The parent re-renders with the transcript as the draft.
        view.rerender(<TrustQuestionStep {...props({ onRecord, onSubmit, answer: TRANSCRIPT })} />);
        expect(screen.getByText(message('worker_onboarding.common.voice_badge'))).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'trust.question.1', value: { text: TRANSCRIPT, source: 'voice' } },
        ]);

        // Edited, it is the worker's own text again — badge gone, and the
        // engine is told `text`, because that is what it now is.
        onSubmit.mockClear();
        view.rerender(<TrustQuestionStep {...props({ onRecord, onSubmit, answer: `${TRANSCRIPT} And I tile.` })} />);
        expect(screen.queryByText(message('worker_onboarding.common.voice_badge'))).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'trust.question.1', value: { text: `${TRANSCRIPT} And I tile.` } },
        ]);
    });

    // FALLBACK 1: no MediaRecorder at all (older Safari, locked-down webview).
    it('disables the mic when the browser cannot record, and leaves typing untouched', async () => {
        installMicrophone();
        const onRecord = vi.fn();
        renderIntl(<TrustQuestionStep {...props({ onRecord })} />);

        const mic = screen.getByRole('button', { name: message('worker_onboarding.question.mic_label') });
        expect(mic).toBeDisabled();
        expect(mic).toHaveAttribute('title', message('worker_onboarding.trust.voice.unsupported'));

        const box = screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'));
        expect(box).toBeEnabled();
        expect(onRecord).not.toHaveBeenCalled();
    });

    // FALLBACK 2: the permission prompt is refused.
    it('says so when the microphone is denied, and never starts a recording', async () => {
        installMediaRecorder();
        installMicrophone('denied');
        const onRecord = vi.fn();
        const onAnswerChange = vi.fn();

        await record(onRecord, { onAnswerChange });

        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.trust.voice.denied'));
        expect(onRecord).not.toHaveBeenCalled();
        // The textarea is exactly as it was: text is the primary path.
        expect(onAnswerChange).not.toHaveBeenCalled();
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'))).toBeEnabled();
        // And the mic is offered again, not stuck in a recording state.
        expect(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.start') })).toBeEnabled();
    });

    it.each([
        ['unusable', 'no_speech'],
        ['timeout', 'timeout'],
        ['failed', 'failed'],
        ['conflict', 'conflict'],
    ])('explains a %s outcome in one sentence and keeps the answer box alone', async (kind, key) => {
        installMediaRecorder();
        installMicrophone();
        const onAnswerChange = vi.fn();
        const onRecord = vi.fn().mockResolvedValue({ kind });

        await record(onRecord, { onAnswerChange });
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        expect(screen.getByRole('alert')).toHaveTextContent(message(`worker_onboarding.trust.voice.${key}`));
        expect(onAnswerChange).not.toHaveBeenCalled();
    });

    it('explains an oversized recording as too long, not as a generic failure', async () => {
        installMediaRecorder();
        installMicrophone();
        const onRecord = vi.fn().mockResolvedValue({ kind: 'rejected', reason: 'file_too_large' });

        await record(onRecord);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.trust.voice.too_long'));
    });

    it('never lets a rejected promise escape the component', async () => {
        installMediaRecorder();
        installMicrophone();
        const onRecord = vi.fn().mockRejectedValue(new Error('boom'));

        await record(onRecord);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.trust.voice.failed'));
    });

    // The transcribe call carries the lockVersion that was current when the
    // mic was pressed. Both of these mutate the run and move that version, so
    // for as long as a recording is in flight neither may be reachable —
    // otherwise a worker who presses Next mid-sentence gets a 409 and is told
    // to reload for no reason they can see.
    it('locks Back and Next for as long as a recording is in flight', async () => {
        installMediaRecorder();
        installMicrophone();
        const onRecord = vi.fn().mockResolvedValue({ kind: 'transcribed', transcript: TRANSCRIPT });

        await record(onRecord);

        expect(screen.getByRole('button', { name: message('worker_onboarding.question.cta') })).toBeDisabled();
        expect(screen.getByRole('button', { name: /back|atrás/i })).toBeDisabled();

        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        // ...and released again once the transcript is back.
        expect(screen.getByRole('button', { name: /back|atrás/i })).toBeEnabled();
    });

    it('releases the microphone when the recording stops', async () => {
        installMediaRecorder();
        const track = installMicrophone();
        const onRecord = vi.fn().mockResolvedValue({ kind: 'transcribed', transcript: TRANSCRIPT });

        await record(onRecord);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.stop') }));

        expect(track.stop).toHaveBeenCalled();
    });

    it('releases the microphone when the screen unmounts mid-recording', async () => {
        installMediaRecorder();
        const track = installMicrophone();
        const onRecord = vi.fn();

        const { view } = await record(onRecord);
        view.unmount();

        expect(track.stop).toHaveBeenCalled();
    });

    it('says all of it in Spanish', async () => {
        installMediaRecorder();
        installMicrophone('denied');
        renderIntl(<TrustQuestionStep {...props({ onRecord: vi.fn() })} />, 'es');
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.trust.voice.start', 'es') }));
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.trust.voice.denied', 'es'));
    });
});
