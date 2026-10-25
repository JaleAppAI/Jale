// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { OnboardingState } from '@/lib/api/worker';
import type { TutorialHandle, UseTutorialOptions } from '@/lib/tutorials/types';

/*
 * W1, the onboarding tutorial: how the flow asks for it.
 *
 * The flow passes its K1.5 "has done the task" signal -- the run is `ready` --
 * and asks the tutorial to open itself ONCE, on the first screen of the flow
 * (the terms). A worker resuming later in the run, a finished run, or a run
 * stopped on an exit panel never asks. Whether it actually opens (a record,
 * the signal, another overlay) is the tutorial hook's decision, so the hook is
 * replaced here by a recorder.
 */

const { api, router, tutorial } = vi.hoisted(() => {
    const handle = {
        maybeAutoOpen: vi.fn(),
        runBeforeHost: vi.fn((openHost: () => void) => openHost()),
        runWithHost: vi.fn((openHost: () => void) => openHost()),
        replay: vi.fn(),
    };
    return {
        api: {
            getWorkerOnboarding: vi.fn(),
            postOnboardingAnswers: vi.fn(),
            postOnboardingBack: vi.fn(),
            patchOnboardingLanguage: vi.fn(),
        },
        router: { replace: vi.fn(), push: vi.fn() },
        tutorial: {
            handle,
            useTutorial: vi.fn((id: string, options: UseTutorialOptions): TutorialHandle => {
                void id;
                void options;
                return handle;
            }),
        },
    };
});

vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async () => []),
    locationDatasetFailed: () => false,
}));
vi.mock('@/lib/api/worker', () => api);
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    usePathname: () => '/worker/onboarding',
}));
vi.mock('@/lib/tutorials/use-tutorial', () => ({ useTutorial: tutorial.useTutorial }));

import { OnboardingFlow } from '@/components/worker/onboarding/OnboardingFlow';
import { THREE_QUESTIONS, onboardingState, renderIntl } from './render-intl';

function at(stepKey: string, overrides: Partial<OnboardingState> = {}): OnboardingState {
    const base = onboardingState({
        trust: { questions: THREE_QUESTIONS, answers: [] },
        ...overrides,
    });
    return { ...base, run: { ...base.run, stepKey } };
}

/** Every `done` the flow handed the hook, in render order. */
function doneValues(): Array<boolean | undefined> {
    return tutorial.useTutorial.mock.calls.map(([, options]) => options.done);
}

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
});

describe('OnboardingFlow — the W1 tutorial', () => {
    it('asks for worker_onboarding, not done, and asks it to open once on the terms screen', () => {
        renderIntl(<OnboardingFlow token="id-token" initialState={at('legal.review')} />);

        expect(tutorial.useTutorial).toHaveBeenCalled();
        expect(tutorial.useTutorial.mock.calls.every(([id]) => id === 'worker_onboarding')).toBe(true);
        expect(new Set(doneValues())).toEqual(new Set([false]));
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });

    it('asks only once however often the flow renders', () => {
        const { rerender } = renderIntl(<OnboardingFlow token="id-token" initialState={at('legal.review')} />);
        rerender(<OnboardingFlow token="id-token" initialState={at('legal.review')} />);
        rerender(<OnboardingFlow token="id-token" initialState={at('legal.review')} />);

        expect(tutorial.useTutorial.mock.calls.length).toBeGreaterThan(1);
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });

    it('does not ask a worker who resumes past the first screen', () => {
        renderIntl(<OnboardingFlow token="id-token" initialState={at('trust.question.2')} />);

        expect(new Set(doneValues())).toEqual(new Set([false]));
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('passes done for a finished run, and does not ask from the summary', () => {
        renderIntl(<OnboardingFlow token="id-token" initialState={at('trust.question.3', { lifecycle: 'ready' })} />);

        expect(new Set(doneValues())).toEqual(new Set([true]));
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('does not ask over an exit panel', () => {
        // A suspended worker gets the exit panel on what would be the first screen.
        renderIntl(<OnboardingFlow token="id-token" initialState={at('legal.review', { lifecycle: 'suspended' })} />);
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('does not ask from a run parked on a step this flow cannot drive', () => {
        renderIntl(<OnboardingFlow token="id-token" initialState={at('profile.photo')} />);
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });
});
