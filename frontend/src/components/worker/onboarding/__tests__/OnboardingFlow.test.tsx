// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnboardingState } from '@/lib/api/worker';

vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async () => []),
    locationDatasetFailed: () => false,
}));

const { api, router } = vi.hoisted(() => ({
    api: {
        getWorkerOnboarding: vi.fn(),
        postOnboardingAnswers: vi.fn(),
        postOnboardingBack: vi.fn(),
        patchOnboardingLanguage: vi.fn(),
    },
    router: { replace: vi.fn(), push: vi.fn() },
}));

vi.mock('@/lib/api/worker', () => api);
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    usePathname: () => '/worker/onboarding',
}));

import { OnboardingFlow } from '@/components/worker/onboarding/OnboardingFlow';
import { THREE_QUESTIONS, interpolate, message, onboardingState, renderIntl } from './render-intl';

const TOKEN = 'id-token';
const LONG_ANSWER = 'I frame houses and set trusses with a crew.';

function at(stepKey: string, overrides: Partial<OnboardingState> = {}): OnboardingState {
    const base = onboardingState({
        trust: { questions: THREE_QUESTIONS, answers: [] },
        profile: {
            fullName: null, location: null,
            trade: { key: 'carpenter', other: null },
            yearsExperience: null, hasTransportation: null, availability: null,
        },
        ...overrides,
    });
    return { ...base, run: { ...base.run, stepKey, lockVersion: base.run.lockVersion } };
}

/** Every post resolves with the run advanced to `nextStep`. */
function advancesTo(nextStep: string, overrides: Partial<OnboardingState> = {}) {
    return async () => ({ kind: 'saved' as const, state: at(nextStep, overrides) });
}

beforeEach(() => {
    vi.clearAllMocks();
    api.getWorkerOnboarding.mockResolvedValue(at('legal.review'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('OnboardingFlow — a fresh worker walks the whole flow', () => {
    it('goes terms → about → trade → work → q1 → q2 → q3 → photo → done', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers
            .mockImplementationOnce(advancesTo('profile.name'))
            .mockImplementationOnce(advancesTo('profile.trade'))
            .mockImplementationOnce(advancesTo('profile.experience'))
            .mockImplementationOnce(advancesTo('trust.question.1'))
            .mockImplementationOnce(advancesTo('trust.question.2'))
            .mockImplementationOnce(advancesTo('trust.question.3'))
            // The third answer COMPLETES the run: the engine has no photo step.
            .mockImplementationOnce(advancesTo('trust.question.3', { lifecycle: 'ready' }));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);

        // 1 — terms
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 1,
            answers: [{ stepKey: 'legal.review', value: 'accept' }],
        });

        // 2 — about
        await screen.findByRole('heading', { name: message('worker_onboarding.about.title') });
        await user.type(screen.getByLabelText(message('worker_onboarding.about.first_name')), 'David');
        await user.type(screen.getByLabelText(message('worker_onboarding.about.last_name')), 'Castellanos');
        await user.type(screen.getByRole('combobox'), '79901');
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.about.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 1,
            answers: [
                { stepKey: 'profile.name', value: 'David Castellanos' },
                { stepKey: 'profile.location', value: { kind: 'zip', zip: '79901' } },
            ],
        });

        // 3 — trade
        await screen.findByRole('heading', { name: message('worker_onboarding.trade.title') });
        await user.click(screen.getByRole('button', { name: message('worker_vocab.trade.carpenter') }));
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.trade.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 1,
            answers: [{ stepKey: 'profile.trade', value: 'carpenter' }],
        });

        // 4 — your work, all three answers in one batch
        await screen.findByRole('heading', { name: message('worker_onboarding.work.title') });
        await user.click(screen.getByRole('button', { name: message('worker_vocab.experience.2-4') }));
        await user.click(screen.getByRole('button', { name: message('worker_vocab.transport.yes') }));
        await user.click(screen.getByRole('button', { name: message('worker_vocab.availability.full_time') }));
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.work.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 1,
            answers: [
                { stepKey: 'profile.experience', value: '2-4' },
                { stepKey: 'profile.transportation', value: true },
                { stepKey: 'profile.availability', value: 'full_time' },
            ],
        });

        // 5, 6, 7 — the three questions
        for (const index of [1, 2, 3] as const) {
            await screen.findByRole('heading', { name: THREE_QUESTIONS[index - 1].q_en });
            await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
            const label = index === 3
                ? message('worker_onboarding.question.last_cta')
                : message('worker_onboarding.question.cta');
            await user.click(screen.getByRole('button', { name: label }));
            expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
                lockVersion: 1,
                answers: [{ stepKey: `trust.question.${index}`, value: { text: LONG_ANSWER } }],
            });
        }

        // 8 — photo: shown once, client-side, and posts NOTHING
        await screen.findByRole('heading', { name: message('worker_onboarding.photo.title') });
        const postsBeforePhoto = api.postOnboardingAnswers.mock.calls.length;
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.photo.skip') }));
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(postsBeforePhoto);

        // Done
        expect(await screen.findByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(7);
    });
});

describe('OnboardingFlow — resuming a run started on WhatsApp', () => {
    it('lands on question 2 and still holds the answer given to question 1', async () => {
        const user = userEvent.setup();
        const resumed = at('trust.question.2', {
            trust: {
                questions: THREE_QUESTIONS,
                answers: [{ index: 1, text: 'I mostly frame houses in Helotes.', source: 'voice' }],
            },
        });
        api.postOnboardingBack.mockResolvedValue(at('trust.question.1', {
            trust: {
                questions: THREE_QUESTIONS,
                answers: [{ index: 1, text: 'I mostly frame houses in Helotes.', source: 'voice' }],
            },
        }));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={resumed} />);

        expect(screen.getByRole('heading', { name: THREE_QUESTIONS[1].q_en })).toBeInTheDocument();
        expect(screen.getByText(interpolate(message('worker_onboarding.question.eyebrow'), { number: 2 }))).toBeInTheDocument();
        // Question 2 is blank; question 1's answer is only a Back away.
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'))).toHaveValue('');

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.back') }));
        expect(api.postOnboardingBack).toHaveBeenCalledWith(TOKEN, { lockVersion: 1 });
        await screen.findByRole('heading', { name: THREE_QUESTIONS[0].q_en });
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')))
            .toHaveValue('I mostly frame houses in Helotes.');
        expect(screen.getByText(message('worker_onboarding.common.voice_badge'))).toBeInTheDocument();
    });
});

describe('OnboardingFlow — the other door moved first', () => {
    it('retries once with the fresh state the 409 body carries, without a second GET', async () => {
        const user = userEvent.setup();
        const fresh = { ...at('legal.review'), run: { ...at('legal.review').run, lockVersion: 7 } };
        api.postOnboardingAnswers
            .mockResolvedValueOnce({ kind: 'lock_conflict', state: fresh })
            .mockResolvedValueOnce({ kind: 'saved', state: at('profile.name') });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));

        await screen.findByRole('heading', { name: message('worker_onboarding.about.title') });
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(2);
        // The retry carries the FRESH lock version, and cost no extra round trip.
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 7,
            answers: [{ stepKey: 'legal.review', value: 'accept' }],
        });
        expect(api.getWorkerOnboarding).not.toHaveBeenCalled();
    });

    it('falls back to a GET when the 409 body carries no state', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers
            .mockResolvedValueOnce({ kind: 'lock_conflict' })
            .mockResolvedValueOnce({ kind: 'saved', state: at('profile.name') });
        api.getWorkerOnboarding.mockResolvedValue({
            ...at('legal.review'),
            run: { ...at('legal.review').run, lockVersion: 7 },
        });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));

        await screen.findByRole('heading', { name: message('worker_onboarding.about.title') });
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(1);
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 7,
            answers: [{ stepKey: 'legal.review', value: 'accept' }],
        });
    });

    it('gives up after one retry rather than looping', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'lock_conflict' });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));

        await waitFor(() => expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(2);
    });
});

describe('OnboardingFlow — the engine refused a step', () => {
    it('shows the reason inline against the rejected field and stays put', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({
            kind: 'step_rejected',
            rejectedStepKey: 'profile.location',
            reason: 'unknown_city',
            state: at('profile.location'),
        });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.name')} />);
        await user.type(screen.getByLabelText(message('worker_onboarding.about.first_name')), 'David');
        await user.type(screen.getByLabelText(message('worker_onboarding.about.last_name')), 'Castellanos');
        await user.type(screen.getByRole('combobox'), '79901');
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.about.cta') }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(message('worker_onboarding.rejection.generic'));
        // Still on About — a rejection is not a step forward.
        expect(screen.getByRole('heading', { name: message('worker_onboarding.about.title') })).toBeInTheDocument();
    });
});

describe('OnboardingFlow — the summary polls for the extraction', () => {
    it('flips to the extracted skills and then stops polling', async () => {
        vi.useFakeTimers();
        const pending = at('profile.photo', {
            lifecycle: 'ready',
            extraction: { status: 'extracting', extracted: null, summary_en: null, summary_es: null },
        });
        const completed = at('profile.photo', {
            lifecycle: 'ready',
            extraction: {
                status: 'completed',
                extracted: { skills: [{ label_en: 'Framing', label_es: 'Estructura', source: [1] }] },
                summary_en: 'Frames residential builds.',
                summary_es: 'Hace estructura de casas.',
            },
        });
        api.getWorkerOnboarding.mockResolvedValueOnce(pending).mockResolvedValue(completed);

        renderIntl(<OnboardingFlow token={TOKEN} initialState={pending} />);
        expect(screen.getByText(message('worker_onboarding.done.working'))).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(3000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(2);

        expect(screen.getByText(message('worker_onboarding.done.extracted'))).toBeInTheDocument();
        expect(screen.getByText('Framing')).toBeInTheDocument();

        // Completed means done: no further polls, however long the tab stays open.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(2);
    });

    it('gives up after 60 seconds rather than polling a stuck extraction forever', async () => {
        vi.useFakeTimers();
        const pending = at('profile.photo', {
            lifecycle: 'ready',
            extraction: { status: 'pending', extracted: null, summary_en: null, summary_es: null },
        });
        api.getWorkerOnboarding.mockResolvedValue(pending);

        renderIntl(<OnboardingFlow token={TOKEN} initialState={pending} />);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(20);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(20);
        expect(screen.getByText(message('worker_onboarding.done.working'))).toBeInTheDocument();
    });
});

describe('OnboardingFlow — language is a header toggle, not a step', () => {
    it('writes preferred_language and moves to the other locale route', async () => {
        const user = userEvent.setup();
        api.patchOnboardingLanguage.mockResolvedValue(at('legal.review'));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.header.language_es') }));

        await waitFor(() => expect(api.patchOnboardingLanguage).toHaveBeenCalledWith(TOKEN, { preferredLanguage: 'es' }));
        expect(router.replace).toHaveBeenCalledWith('/worker/onboarding', { locale: 'es' });
    });
});

describe('OnboardingFlow — a finished run', () => {
    it('shows the summary with no way back: the engine cannot rewind a completed run', () => {
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.3', { lifecycle: 'ready' })} />);
        expect(screen.getByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('worker_onboarding.common.back') })).not.toBeInTheDocument();
        // And no photo prompt on a reload — it is optional and already past.
        expect(screen.queryByRole('heading', { name: message('worker_onboarding.photo.title') })).not.toBeInTheDocument();
    });

    it('lets a worker walk back into an earlier question BEFORE the last answer', async () => {
        const user = userEvent.setup();
        api.postOnboardingBack.mockResolvedValue(at('trust.question.1'));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.2')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.back') }));

        expect(api.postOnboardingBack).toHaveBeenCalledWith(TOKEN, { lockVersion: 1 });
        expect(await screen.findByRole('heading', { name: THREE_QUESTIONS[0].q_en })).toBeInTheDocument();
    });
});

describe('OnboardingFlow — a worker the engine will not onboard', () => {
    it('stops on a suspended run instead of showing a form that cannot save', () => {
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review', { lifecycle: 'suspended' })} />);
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.blocked.suspended'));
        expect(screen.queryByRole('button', { name: message('worker_onboarding.terms.cta') })).not.toBeInTheDocument();
    });

    it('stops when a save comes back not_onboardable', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'blocked', reason: 'not_onboardable' });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));

        expect(await screen.findByRole('alert')).toHaveTextContent(message('worker_onboarding.blocked.not_onboardable'));
    });
});

describe('OnboardingFlow — the client is behind the run', () => {
    it('re-reads and re-renders on a step mismatch rather than retrying', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'step_mismatch' });
        api.getWorkerOnboarding.mockResolvedValue(at('trust.question.1'));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));

        expect(await screen.findByRole('heading', { name: THREE_QUESTIONS[0].q_en })).toBeInTheDocument();
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(1);
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(1);
    });
});
