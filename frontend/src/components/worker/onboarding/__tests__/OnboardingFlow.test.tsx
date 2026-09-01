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

function at(stepKey: string, overrides: Partial<OnboardingState> = {}, lockVersion = 1): OnboardingState {
    const base = onboardingState({
        trust: { questions: THREE_QUESTIONS, answers: [] },
        profile: {
            fullName: null, location: null,
            trade: { key: 'carpenter', other: null },
            yearsExperience: null, hasTransportation: null, availability: null,
        },
        ...overrides,
    });
    return { ...base, run: { ...base.run, stepKey, lockVersion } };
}

/**
 * The engine bumps the lock on EVERY write, so the fixtures do too. If they
 * all answered `lockVersion: 1` the walk below would pass whether or not the
 * flow re-seeded the lock from each response -- and a client that keeps
 * posting a stale lock 409s against itself the moment anything else touches
 * the run.
 */
let lock = 1;

/** Every post resolves with the run advanced to `nextStep`, lock bumped. */
function advancesTo(nextStep: string, overrides: Partial<OnboardingState> = {}) {
    return async () => {
        lock += 1;
        return { kind: 'saved' as const, state: at(nextStep, overrides, lock) };
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    lock = 1;
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
            // Each save carries the lock the PREVIOUS response handed back.
            lockVersion: 2,
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
            lockVersion: 3,
            answers: [{ stepKey: 'profile.trade', value: 'carpenter' }],
        });

        // 4 — your work, all three answers in one batch
        await screen.findByRole('heading', { name: message('worker_onboarding.work.title') });
        await user.click(screen.getByRole('button', { name: message('worker_vocab.experience.2-4') }));
        await user.click(screen.getByRole('button', { name: message('worker_vocab.transport.yes') }));
        await user.click(screen.getByRole('button', { name: message('worker_vocab.availability.full_time') }));
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.work.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 4,
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
                ? message('worker_onboarding.trust.complete_cta')
                : message('worker_onboarding.question.cta');
            await user.click(screen.getByRole('button', { name: label }));
            expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
                lockVersion: index + 4,
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
        // And it stops SAYING it is working: a spinner nobody is turning reads
        // as a broken page the worker should keep waiting on.
        expect(screen.queryByText(message('worker_onboarding.done.working'))).not.toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.done.stalled'))).toBeInTheDocument();
    });

    it('does not hand itself a second budget when the status moves pending → extracting', async () => {
        vi.useFakeTimers();
        const pending = at('profile.photo', {
            lifecycle: 'ready',
            extraction: { status: 'pending', extracted: null, summary_en: null, summary_es: null },
        });
        const extracting = at('profile.photo', {
            lifecycle: 'ready',
            extraction: { status: 'extracting', extracted: null, summary_en: null, summary_es: null },
        });
        // The very first poll flips the status, which re-runs the effect. A
        // counter that lived in the effect would restart at zero right here.
        api.getWorkerOnboarding.mockResolvedValueOnce(extracting).mockResolvedValue(extracting);

        renderIntl(<OnboardingFlow token={TOKEN} initialState={pending} />);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(api.getWorkerOnboarding).toHaveBeenCalledTimes(20);
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
        // A banner alone is a dead end; there is always a door out.
        expect(screen.getByRole('button', { name: message('worker_onboarding.common.go_to_profile') })).toBeInTheDocument();
    });

    it('keeps its own message when the run is ALSO parked on an unmappable step', () => {
        // Both conditions hold at once here; "on hold" is the more specific
        // and more useful thing to say, so the blocked banner wins.
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.photo', { lifecycle: 'suspended' })} />);
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.blocked.suspended'));
        expect(screen.queryByText(message('worker_onboarding.stuck'))).not.toBeInTheDocument();
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

describe('OnboardingFlow — the lock version follows the run, not the page load', () => {
    it('re-seeds it from the Back response before the next save', async () => {
        const user = userEvent.setup();
        api.postOnboardingBack.mockResolvedValue(at('trust.question.1', {}, 9));
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'saved', state: at('trust.question.2', {}, 10) });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.2')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.back') }));
        expect(api.postOnboardingBack).toHaveBeenCalledWith(TOKEN, { lockVersion: 1 });

        await screen.findByRole('heading', { name: THREE_QUESTIONS[0].q_en });
        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));

        // Back is a write: it moved the run and the lock with it.
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 9,
            answers: [{ stepKey: 'trust.question.1', value: { text: LONG_ANSWER } }],
        });
    });

    it('re-seeds it from the language PATCH', async () => {
        const user = userEvent.setup();
        api.patchOnboardingLanguage.mockResolvedValue(at('legal.review', {}, 4));
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'saved', state: at('profile.name', {}, 5) });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('legal.review')} />);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.header.language_es') }));
        await waitFor(() => expect(api.patchOnboardingLanguage).toHaveBeenCalledTimes(1));

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.terms.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 4,
            answers: [{ stepKey: 'legal.review', value: 'accept' }],
        });
    });
});

describe('OnboardingFlow — parked on a step this door cannot drive', () => {
    it('shows the way out instead of a Continue that could only be refused', async () => {
        const user = userEvent.setup();
        // Real WhatsApp runs sit on `profile.photo`: no handler advances it, so
        // the fallback screen's Continue would post `legal.review` forever.
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.photo')} />);

        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.stuck'));
        expect(screen.queryByRole('button', { name: message('worker_onboarding.terms.cta') })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.go_to_profile') }));
        expect(router.replace).toHaveBeenCalledWith('/worker/profile');
        expect(api.postOnboardingAnswers).not.toHaveBeenCalled();
    });

    it('does the same for a step key a later workflow version invents', () => {
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.some_new_step')} />);
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.stuck'));
    });

    it('says it in Spanish too', () => {
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.photo')} />, 'es');
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.stuck', 'es'));
    });

    it('never fires on a completed run — the summary owns that page', () => {
        // `run.stepKey` still reads `profile.photo` on plenty of finished runs.
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.photo', { lifecycle: 'ready' })} />);
        expect(screen.getByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(screen.queryByText(message('worker_onboarding.stuck'))).not.toBeInTheDocument();
    });
});

describe('OnboardingFlow — the run moved between our read and our write', () => {
    it('keeps the answer being typed when the engine is still on the same screen', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'step_mismatch' });
        api.getWorkerOnboarding.mockResolvedValue(at('trust.question.2', {}, 6));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.2')} />);
        const box = screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'));
        await user.type(box, LONG_ANSWER);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));

        // Told what happened...
        expect(await screen.findByText(message('worker_onboarding.rejection.step_mismatch'))).toBeInTheDocument();
        // ...without losing the sentence they just wrote...
        expect(box).toHaveValue(LONG_ANSWER);
        // ...and Continue still works, on the lock the refetch brought back.
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));
        expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(2);
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 6,
            answers: [{ stepKey: 'trust.question.2', value: { text: LONG_ANSWER } }],
        });
    });

    it('rebuilds from the server when the engine has moved to a different screen', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockResolvedValue({ kind: 'step_mismatch' });
        api.getWorkerOnboarding.mockResolvedValue(at('trust.question.3'));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.2')} />);
        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.question.cta') }));

        expect(await screen.findByRole('heading', { name: THREE_QUESTIONS[2].q_en })).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.rejection.step_mismatch'))).toBeInTheDocument();
        // Question 3's box is question 3's: the draft did not follow.
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'))).toHaveValue('');
    });
});

describe('OnboardingFlow — switching language mid-answer', () => {
    it('does not cost the worker what they had already typed', async () => {
        const user = userEvent.setup();
        const typed = 'x'.repeat(200);
        api.patchOnboardingLanguage.mockResolvedValue(at('trust.question.1'));

        const view = renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.1')} />);
        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), typed);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.header.language_es') }));
        await waitFor(() => expect(api.patchOnboardingLanguage).toHaveBeenCalledTimes(1));

        // The toggle is a ROUTE change: next-intl remounts the tree under the
        // other locale. That is what this unmount/remount stands in for.
        view.unmount();
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.1')} />, 'es');

        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder', 'es'))).toHaveValue(typed);
    });

    it('does not pour a parked answer into a different step', async () => {
        const user = userEvent.setup();
        api.patchOnboardingLanguage.mockResolvedValue(at('trust.question.1'));

        const view = renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.1')} />);
        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.header.language_es') }));
        await waitFor(() => expect(api.patchOnboardingLanguage).toHaveBeenCalledTimes(1));
        view.unmount();

        // WhatsApp moved them on while the route was changing.
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.2')} />, 'es');
        expect(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder', 'es'))).toHaveValue('');
    });
});

describe('OnboardingFlow — a save that keeps failing', () => {
    it('offers the way out on the second failure, not the first', async () => {
        const user = userEvent.setup();
        api.postOnboardingAnswers.mockRejectedValue(new Error('network'));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.1')} />);
        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
        const cta = screen.getByRole('button', { name: message('worker_onboarding.question.cta') });

        await user.click(cta);
        await waitFor(() => expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(1));
        // One failure is a blip; the retry is right there and it is the right
        // thing to press.
        expect(screen.queryByRole('button', { name: message('worker_onboarding.common.go_to_profile') })).not.toBeInTheDocument();

        await user.click(cta);
        await waitFor(() => expect(api.postOnboardingAnswers).toHaveBeenCalledTimes(2));
        const exit = await screen.findByRole('button', { name: message('worker_onboarding.common.go_to_profile') });
        await user.click(exit);
        expect(router.replace).toHaveBeenCalledWith('/worker/profile');
    });
});

describe('OnboardingFlow — a run in the middle of WhatsApp voice intake', () => {
    it('sends them back to the door that can finish it', () => {
        // Every step this screen could post is BEHIND `profile.voice_choice`,
        // so any Continue here is a batch the engine refuses.
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.voice_choice')} />);
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.stuck'));
        expect(screen.queryByRole('button', { name: message('worker_onboarding.terms.cta') })).not.toBeInTheDocument();
    });
});

describe('OnboardingFlow — changing an earlier answer before the last one is sent', () => {
    const A1 = 'I frame houses and set trusses.';
    const A1_EDITED = 'I frame houses, set trusses and hang doors.';
    const A2 = 'I read plans and set my own lines.';
    const A3 = 'I want steady work close to home.';

    /** A run at `stepKey` holding exactly these answers. */
    function withAnswers(stepKey: string, indexes: number[], lockVersion: number) {
        const texts: Record<number, string> = { 1: A1, 2: A2, 3: A3 };
        return at(stepKey, {
            trust: {
                questions: THREE_QUESTIONS,
                answers: indexes.map((index) => ({ index, text: texts[index], source: 'text' as const })),
            },
        }, lockVersion);
    }

    it('walks back to question 1 and forward again with every stored answer still there', async () => {
        const user = userEvent.setup();
        const answer = () => screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'));
        const next = () => screen.getByRole('button', { name: message('worker_onboarding.question.cta') });
        const back = () => screen.getByRole('button', { name: message('worker_onboarding.common.back') });

        api.postOnboardingAnswers
            .mockResolvedValueOnce({ kind: 'saved', state: withAnswers('trust.question.2', [1], 2) })
            .mockResolvedValueOnce({ kind: 'saved', state: withAnswers('trust.question.3', [1, 2], 3) })
            // Forward again after the edit.
            .mockResolvedValueOnce({ kind: 'saved', state: withAnswers('trust.question.2', [1, 2], 6) })
            .mockResolvedValueOnce({ kind: 'saved', state: withAnswers('trust.question.3', [1, 2, 3], 7) });
        api.postOnboardingBack
            .mockResolvedValueOnce(withAnswers('trust.question.2', [1, 2], 4))
            .mockResolvedValueOnce(withAnswers('trust.question.1', [1, 2], 5));

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.1')} />);

        // Forward through the first two.
        await user.type(answer(), A1);
        await user.click(next());
        await screen.findByRole('heading', { name: THREE_QUESTIONS[1].q_en });
        await user.type(answer(), A2);
        await user.click(next());
        await screen.findByRole('heading', { name: THREE_QUESTIONS[2].q_en });

        // Back twice, to the first question. Each `back` is a write, so each
        // one hands back a new lock.
        await user.click(back());
        await screen.findByRole('heading', { name: THREE_QUESTIONS[1].q_en });
        expect(api.postOnboardingBack).toHaveBeenLastCalledWith(TOKEN, { lockVersion: 3 });
        // The answer already given is in the box, not lost behind them.
        expect(answer()).toHaveValue(A2);

        await user.click(back());
        await screen.findByRole('heading', { name: THREE_QUESTIONS[0].q_en });
        expect(api.postOnboardingBack).toHaveBeenLastCalledWith(TOKEN, { lockVersion: 4 });
        expect(answer()).toHaveValue(A1);

        // Change it and come forward again.
        await user.clear(answer());
        await user.type(answer(), A1_EDITED);
        await user.click(next());
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 5,
            answers: [{ stepKey: 'trust.question.1', value: { text: A1_EDITED } }],
        });

        // Question 2 is not retyped to get past it.
        await screen.findByRole('heading', { name: THREE_QUESTIONS[1].q_en });
        expect(answer()).toHaveValue(A2);
        await user.click(next());
        expect(api.postOnboardingAnswers).toHaveBeenLastCalledWith(TOKEN, {
            lockVersion: 6,
            answers: [{ stepKey: 'trust.question.2', value: { text: A2 } }],
        });

        // And question 3 shows whatever the server holds for it — this run has
        // an answer stored there (the other door can have written one), and it
        // is prefilled rather than asked again.
        await screen.findByRole('heading', { name: THREE_QUESTIONS[2].q_en });
        expect(answer()).toHaveValue(A3);
        expect(screen.getByRole('button', { name: message('worker_onboarding.trust.complete_cta') })).toBeEnabled();
    });

    it('does not carry an UNSENT answer back and forward — only what the server has', async () => {
        const user = userEvent.setup();
        const answer = () => screen.getByPlaceholderText(message('worker_onboarding.question.placeholder'));

        // Typed on question 3 and never sent, so no door has it. Back lands on
        // question 2 and the run's own state is what fills the box.
        api.postOnboardingBack.mockResolvedValue(withAnswers('trust.question.2', [1, 2], 4));
        renderIntl(<OnboardingFlow token={TOKEN} initialState={withAnswers('trust.question.3', [1, 2], 3)} />);

        await user.type(answer(), 'Something I typed but never sent at all.');
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.back') }));

        await screen.findByRole('heading', { name: THREE_QUESTIONS[1].q_en });
        expect(answer()).toHaveValue(A2);
    });
});

describe('OnboardingFlow — after the last answer there is no way back', () => {
    it('offers no Back on the photo prompt or the summary, and calls /back from neither', async () => {
        const user = userEvent.setup();
        const backLabel = message('worker_onboarding.common.back');
        api.postOnboardingAnswers.mockResolvedValue({
            kind: 'saved',
            state: at('trust.question.3', { lifecycle: 'ready' }, 4),
        });

        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.3')} />);
        // The question itself still has one, right up to the last press.
        expect(screen.getByRole('button', { name: backLabel })).toBeInTheDocument();

        await user.type(screen.getByPlaceholderText(message('worker_onboarding.question.placeholder')), LONG_ANSWER);
        await user.click(screen.getByRole('button', { name: message('worker_onboarding.trust.complete_cta') }));

        // Photo: the run is complete, and `back` only walks an active run.
        await screen.findByRole('heading', { name: message('worker_onboarding.photo.title') });
        expect(screen.queryByRole('button', { name: backLabel })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.photo.finish') }));

        // Summary: same.
        expect(await screen.findByText(message('worker_onboarding.done.title'))).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: backLabel })).not.toBeInTheDocument();
        expect(api.postOnboardingBack).not.toHaveBeenCalled();
    });

    it('has no "improve my answers" control on the summary — Luis, 2026-08-29', () => {
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('trust.question.3', { lifecycle: 'ready' })} />);
        // `includes`, not equality: the Button paints a hidden copy of its
        // label to hold its width while loading, so the text node repeats.
        const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
        // The language toggle pair aside, the summary offers exactly one way
        // on, and nothing here reopens the questions.
        expect(buttons.some((label) => label.includes(message('worker_onboarding.done.cta')))).toBe(true);
        expect(buttons.some((label) => /improve|mejorar/i.test(label))).toBe(false);
        expect(buttons).toHaveLength(3);
    });
});
