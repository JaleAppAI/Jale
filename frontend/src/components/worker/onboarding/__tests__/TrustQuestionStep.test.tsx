// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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

    it('shows the mic, disabled, with the coming-soon tooltip — voice ships later', () => {
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

    it('calls the last question Finish', () => {
        renderIntl(<TrustQuestionStep {...props({ index: 3, answer: LONG_ENOUGH })} />);
        expect(screen.getByRole('button', { name: message('worker_onboarding.question.last_cta') })).toBeInTheDocument();
    });

    it('types through the answer callback', async () => {
        const onAnswerChange = vi.fn();
        renderIntl(<TrustQuestionStep {...props({ onAnswerChange })} />);
        await userEvent.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), 'I');
        expect(onAnswerChange).toHaveBeenCalledWith('I');
    });
});
