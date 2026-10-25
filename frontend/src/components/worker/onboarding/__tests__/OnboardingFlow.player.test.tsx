// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { OnboardingState } from '@/lib/api/worker';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import {
    record,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    tutorialCalls,
    watchDialogs,
} from '@/lib/tutorials/__tests__/harness';

/*
 * W1 with the real tutorial: the providers as the app layout mounts them, the
 * real progress store, guide host and content. The onboarding flow opens the
 * step-by-step guide on its first screen for a worker who has no record and
 * has not finished onboarding (K1.5), alone; the slides ("Before you start")
 * stay in Help as the overview. The band carries Help, which replays any
 * worker tutorial's slides.
 */

const { api, router } = vi.hoisted(() => ({
    api: {
        getWorkerOnboarding: vi.fn(),
        postOnboardingAnswers: vi.fn(),
        postOnboardingBack: vi.fn(),
        patchOnboardingLanguage: vi.fn(),
    },
    router: { replace: vi.fn(), push: vi.fn() },
}));

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
    useRouter: () => router,
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});
vi.mock('@/lib/api/worker', () => api);
vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async () => []),
    locationDatasetFailed: () => false,
}));

import { OnboardingFlow } from '@/components/worker/onboarding/OnboardingFlow';
import { THREE_QUESTIONS, onboardingState } from './render-intl';

const catalogues = { en, es } as const;

function providers(locale: 'en' | 'es' = 'en') {
    return function Providers({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
                <OverlayPresenceProvider>
                    <TutorialProgressProvider>{children}</TutorialProgressProvider>
                </OverlayPresenceProvider>
            </NextIntlClientProvider>
        );
    };
}

function at(stepKey: string, overrides: Partial<OnboardingState> = {}): OnboardingState {
    const base = onboardingState({ trust: { questions: THREE_QUESTIONS, answers: [] }, ...overrides });
    return { ...base, run: { ...base.run, stepKey } };
}

function renderFlow(state: OnboardingState, locale: 'en' | 'es' = 'en') {
    return render(<OnboardingFlow token="id-token" initialState={state} />, { wrapper: providers(locale) });
}

/** Two separate acts: the second commits whatever the first one's promises woke up. */
async function settle() {
    for (let turn = 0; turn < 2; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
    // The player's own chunk, fetched up front as the provider's preload does
    // in the app, so "nothing opened" is never passed by a chunk still loading.
    await import('@/components/tutorials/TutorialHost');
    await import('@/components/tutorials/GuideHost');
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    vi.clearAllMocks();
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/worker/onboarding';
    signIn('worker');
});

describe('OnboardingFlow with the real W1 tutorial', () => {
    it('opens the step-by-step guide over the terms screen, alone, instead of the slides', async () => {
        serveTutorials([]);
        const watch = watchDialogs();
        renderFlow(at('legal.review'));

        const intro = await screen.findByRole('dialog', { name: en.tutorial.worker_onboarding.guide.intro_title });
        expect(screen.queryByRole('dialog', { name: 'Before you start' })).toBeNull();
        act(() => within(intro).getByRole('button', { name: en.tutorial.common.guide.worker.start }).click());

        // The first step points at the terms screen's own button.
        await vi.waitFor(() => {
            const layer = document.querySelector('[data-spotlight="worker_onboarding"]');
            expect(layer?.querySelector('[data-step="terms"]')).not.toBeNull();
        });
        act(() => screen.getByRole('button', { name: 'End guide' }).click());
        await settle();
        watch.stop();

        expect(dialogs()).toBe(0);
        expect(watch.most()).toBe(1);
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'worker_onboarding', outcome: 'skipped' }]);
    });

    it('says it in Spanish, with tú', async () => {
        serveTutorials([]);
        renderFlow(at('legal.review'), 'es');

        const intro = await screen.findByRole('dialog', { name: es.tutorial.worker_onboarding.guide.intro_title });
        expect(within(intro).getByRole('button', { name: 'Guíame' })).toBeInTheDocument();
        expect(within(intro).getByRole('button', { name: es.tutorial.common.guide.self })).toBeInTheDocument();
    });

    it('does not open again once the account has a record for it', async () => {
        serveTutorials([record('worker_onboarding', 'skipped')]);
        renderFlow(at('legal.review'));
        await settle();

        expect(tutorialCalls().map(([method]) => method)).toEqual(['GET']);
        expect(dialogs()).toBe(0);
    });

    it('does not open for a worker who has finished onboarding', async () => {
        serveTutorials([]);
        renderFlow(at('trust.question.3', { lifecycle: 'ready' }));
        await settle();

        expect(dialogs()).toBe(0);
        expect(posts()).toEqual([]);
    });

    it('does not open for a worker who resumes past the first screen', async () => {
        serveTutorials([]);
        renderFlow(at('trust.question.2'));
        await settle();

        expect(dialogs()).toBe(0);
    });
});

describe('Help in the onboarding band', () => {
    it('sits beside the language toggle and replays W1 without recording it', async () => {
        serveTutorials([record('worker_onboarding')]);
        renderFlow(at('legal.review'));
        await settle();
        expect(dialogs()).toBe(0);

        const help = screen.getByRole('button', { name: 'Help' });
        const band = screen.getByRole('group', { name: en.worker_onboarding.header.language_group }).parentElement!;
        expect(band.contains(help)).toBe(true);

        act(() => help.focus());
        act(() => help.click());
        const menu = await screen.findByRole('dialog', { name: 'How Jale works' });
        expect(within(menu).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            'Before you start',
            'How applying works',
            'Details requested',
            'Your profile',
        ]);

        act(() => within(menu).getByRole('button', { name: 'Before you start' }).click());
        const dialog = await screen.findByRole('dialog', { name: 'Before you start' });
        expect(screen.queryByRole('dialog', { name: 'How Jale works' })).toBeNull();

        act(() => within(dialog).getByRole('button', { name: 'Skip' }).click());
        await settle();
        expect(dialogs()).toBe(0);
        expect(posts()).toEqual([]);
        // The replay hands focus back to the Help button in the band.
        expect(document.activeElement).toBe(help);
    });

    it('is named in Spanish', async () => {
        serveTutorials([record('worker_onboarding')]);
        renderFlow(at('legal.review'), 'es');
        await settle();

        expect(screen.getByRole('button', { name: 'Ayuda' })).toBeInTheDocument();
    });
});
