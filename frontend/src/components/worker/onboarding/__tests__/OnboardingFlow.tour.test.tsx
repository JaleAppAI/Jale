// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OnboardingState, ReferredJobSummary } from '@/lib/api/worker';
import { fakeIdToken } from '@/lib/tutorials/__tests__/harness';
import { isWorkerTourDue } from '@/lib/tutorials/tour-marker';

/*
 * The worker app tour is due once onboarding is finished: whichever way the
 * worker leaves the summary (the feed, the job they came for, its apply
 * flow), `finish()` marks it for THIS account, and the gate in the layout
 * plays it at the first worker page where nothing else is up. Leaving from
 * the middle of the flow is not finishing it.
 */

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
import { THREE_QUESTIONS, message, onboardingState, renderIntl } from './render-intl';

const ACCOUNT = 'worker-account-one';
const TOKEN = fakeIdToken(ACCOUNT);

const REFERRED: ReferredJobSummary = {
    id: '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071',
    title: 'Concrete Finisher',
    company: 'NB Construction',
    location: 'San Antonio, TX',
    payMin: 22,
    payMax: 26,
    payInterval: 'hourly',
    payRaw: null,
    open: true,
};

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
    return { ...base, run: { ...base.run, stepKey, lockVersion: 1 } };
}

const finished = (overrides: Partial<OnboardingState> = {}) => at('trust.question.3', { lifecycle: 'ready', ...overrides });

const markerKeys = () => Object.keys(window.sessionStorage).filter((key) => key.startsWith('jale.worker_tour_due'));

beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(api)) fn.mockReset();
    window.sessionStorage.clear();
    api.getWorkerOnboarding.mockResolvedValue(at('legal.review'));
});

describe('OnboardingFlow — finishing marks the worker app tour due', () => {
    it('on the way to the feed, for this account only', async () => {
        const user = userEvent.setup({ delay: null });
        renderIntl(<OnboardingFlow token={TOKEN} initialState={finished()} />);
        expect(isWorkerTourDue(ACCOUNT)).toBe(false);

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.done.see_jobs') }));

        expect(router.replace).toHaveBeenCalledWith('/worker/home');
        expect(isWorkerTourDue(ACCOUNT)).toBe(true);
        expect(isWorkerTourDue('worker-account-two')).toBe(false);
    });

    it('on the way into the apply flow of the job they came for', async () => {
        const user = userEvent.setup({ delay: null });
        renderIntl(<OnboardingFlow token={TOKEN} initialState={finished({ referredJob: REFERRED })} />);

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.done.apply') }));

        expect(router.push).toHaveBeenCalledWith(`/worker/jobs/${REFERRED.id}?apply=1`);
        expect(isWorkerTourDue(ACCOUNT)).toBe(true);
    });

    it('not when the worker leaves from the middle of the flow', async () => {
        const user = userEvent.setup({ delay: null });
        renderIntl(<OnboardingFlow token={TOKEN} initialState={at('profile.photo', { referredJob: REFERRED })} />);

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.common.go_to_profile') }));

        expect(router.replace).toHaveBeenCalledWith('/worker/profile');
        expect(markerKeys()).toEqual([]);
    });

    it('writes nothing when the account cannot be read from the token', async () => {
        const user = userEvent.setup({ delay: null });
        renderIntl(<OnboardingFlow token="not-a-token" initialState={finished()} />);

        await user.click(screen.getByRole('button', { name: message('worker_onboarding.done.see_jobs') }));

        expect(router.replace).toHaveBeenCalledWith('/worker/home');
        expect(markerKeys()).toEqual([]);
    });
});
