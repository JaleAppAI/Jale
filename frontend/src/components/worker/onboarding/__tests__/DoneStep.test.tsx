// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DoneStep } from '@/components/worker/onboarding/DoneStep';
import type { OnboardingState } from '@/lib/api/worker';
import { THREE_QUESTIONS, message, onboardingState, renderIntl } from './render-intl';

const FILLED: Partial<OnboardingState> = {
    profile: {
        fullName: 'David Castellanos',
        location: { city: 'San Antonio', state: 'Texas', zip: null },
        trade: { key: 'carpenter', other: null },
        yearsExperience: '2-4',
        hasTransportation: true,
        availability: 'full_time',
    },
    trust: {
        questions: THREE_QUESTIONS,
        answers: [
            { index: 1, text: 'I mostly frame houses and set trusses.', source: 'voice' },
            { index: 2, text: 'Nail gun, circular saw, laser level.', source: 'text' },
        ],
    },
};

function props(overrides: Partial<Parameters<typeof DoneStep>[0]> = {}) {
    return {
        state: onboardingState(FILLED),
        canImprove: true,
        onImprove: vi.fn(),
        onGoToProfile: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof DoneStep>[0];
}

describe('DoneStep', () => {
    it('summarises the profile an employer will see', () => {
        renderIntl(<DoneStep {...props()} />);
        expect(screen.getByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.summary.name'))).toBeInTheDocument();
        expect(screen.getByText('David Castellanos')).toBeInTheDocument();
        expect(screen.getByText('San Antonio, Texas')).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.trade.carpenter'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.experience.2-4'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.availability.full_time'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.transport.yes'))).toBeInTheDocument();
    });

    it('summarises it in Spanish', () => {
        renderIntl(<DoneStep {...props()} />, 'es');
        expect(screen.getByText(message('worker_onboarding.done.title', 'es'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_vocab.trade.carpenter', 'es'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.summary.availability', 'es'))).toBeInTheDocument();
    });

    it('reads back every answer in the worker\'s own words, badged by how it arrived', () => {
        renderIntl(<DoneStep {...props()} />);
        expect(screen.getByText(message('worker_onboarding.done.own_words'))).toBeInTheDocument();
        expect(screen.getByText(THREE_QUESTIONS[0].q_en)).toBeInTheDocument();
        expect(screen.getByText(/I mostly frame houses/)).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.common.voice_badge'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.common.typed_badge'))).toBeInTheDocument();
        // The unanswered third question has no row.
        expect(screen.queryByText(THREE_QUESTIONS[2].q_en)).not.toBeInTheDocument();
    });

    it('shows the questions in Spanish when that is the locale', () => {
        renderIntl(<DoneStep {...props()} />, 'es');
        expect(screen.getByText(THREE_QUESTIONS[0].q_es)).toBeInTheDocument();
    });

    it('says it is still reading while the extraction runs', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: { status: 'extracting', extracted: null, summary_en: null, summary_es: null },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.working'))).toBeInTheDocument();
        expect(screen.queryByText(message('worker_onboarding.done.extracted'))).not.toBeInTheDocument();
    });

    it('flips to the extracted skills, chips and summary when it completes', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: {
                    status: 'completed',
                    extracted: {
                        skills: [{ label_en: 'Framing', label_es: 'Estructura', source: [1] }],
                        safety: [{ label_en: 'Fall protection', label_es: 'Protección contra caídas', source: [1] }],
                    },
                    summary_en: 'Frames residential builds and sets trusses.',
                    summary_es: 'Hace estructura de casas y coloca vigas.',
                },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.extracted'))).toBeInTheDocument();
        expect(screen.getByText('Framing')).toBeInTheDocument();
        expect(screen.getByText('Fall protection')).toBeInTheDocument();
        expect(screen.getByText('Frames residential builds and sets trusses.')).toBeInTheDocument();
        expect(screen.queryByText(message('worker_onboarding.done.working'))).not.toBeInTheDocument();
    });

    it('shows the Spanish chips and summary on the Spanish locale', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: {
                    status: 'completed',
                    extracted: { skills: [{ label_en: 'Framing', label_es: 'Estructura', source: [1] }] },
                    summary_en: 'Frames residential builds.',
                    summary_es: 'Hace estructura de casas.',
                },
            }),
        })} />, 'es');
        expect(screen.getByText('Estructura')).toBeInTheDocument();
        expect(screen.getByText('Hace estructura de casas.')).toBeInTheDocument();
    });

    it('stays honest when the extraction failed — the answers still stand', () => {
        renderIntl(<DoneStep {...props({
            state: onboardingState({
                ...FILLED,
                extraction: { status: 'failed', extracted: null, summary_en: null, summary_es: null },
            }),
        })} />);
        expect(screen.getByText(message('worker_onboarding.done.failed'))).toBeInTheDocument();
    });

    it('sends the worker on to their profile', async () => {
        const onGoToProfile = vi.fn();
        renderIntl(<DoneStep {...props({ onGoToProfile })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.cta') }));
        expect(onGoToProfile).toHaveBeenCalled();
    });

    it('offers "Improve my answers" only while the run is still onboarding', async () => {
        const onImprove = vi.fn();
        const { unmount } = renderIntl(<DoneStep {...props({ onImprove })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.done.improve') }));
        expect(onImprove).toHaveBeenCalled();
        unmount();

        renderIntl(<DoneStep {...props({ canImprove: false })} />);
        expect(screen.queryByRole('button', { name: message('worker_onboarding.done.improve') })).not.toBeInTheDocument();
    });
});
