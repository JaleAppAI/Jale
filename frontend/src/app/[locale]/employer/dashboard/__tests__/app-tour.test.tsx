// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { EmployerBilling, Job } from '@/lib/api/employer';
import { message } from '@/components/worker/onboarding/__tests__/render-intl';
import {
    apiFetch as harnessFetch,
    catalogues,
    jsonResponse,
    record,
    resetHarness,
    serveTutorials,
    signIn,
    tutorialCalls,
} from '@/lib/tutorials/__tests__/harness';

/*
 * The employer app tour's trigger on the dashboard, with the real progress
 * store, overlay coordinator, tour overlay and welcome tutorial (E1). The
 * shell is a stand-in that still renders the page's header action, a nav and
 * a Help button, so the tour has real controls to point at.
 *
 *  - A new employer (an empty board, an account created since the tour's
 *    release, no tour outcome) gets the tour, then the dashboard: E1's
 *    slides do not follow it (hotfix 2026-10-24).
 *  - An older account with an empty board (never posted, or deleted every
 *    job) gets no tour, and is asked about E1 as before; so is one whose
 *    profile read fails.
 *  - With a tour outcome on record, E1 does not auto-play either; it stays in
 *    Help. An account with no tour outcome is asked about E1 as before.
 *  - An employer with a job gets neither.
 */

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));

vi.mock('@/i18n/navigation', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
            <a href={href} {...rest}>{children}</a>
        ),
        usePathname: harness.usePathnameMock,
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    };
});

vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
        <div>
            <header>
                {actions}
                <button type="button" data-tour="help">Help</button>
            </header>
            <nav aria-label="Main navigation">
                <a href="#dashboard" data-nav-key="dashboard">Dashboard</a>
                <a href="#messages" data-nav-key="messages">Messages</a>
            </nav>
            {children}
        </div>
    ),
}));

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/components/employer/PostJobModal', () => ({
    PostJobModal: () => null,
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: vi.fn(),
    getBilling: vi.fn(),
    listJobTemplates: vi.fn(),
    getEmployerProfile: vi.fn(),
}));

vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        items: [], unreadCount: 0, unreadByConversation: {}, loading: false, errorKind: null,
        retry: vi.fn(), refresh: vi.fn(), markRead: vi.fn(),
    }),
    useUnreadCount: () => 0,
}));

type DashboardData = { jobs: Job[]; billing: EmployerBilling | null; templateCount: number | null };
type PageState = { phase: 'loading' | 'ready'; data: DashboardData | null };

/** The board's load, driven from the test: loading first, then ready. */
const page = vi.hoisted(() => {
    let state: { phase: 'loading' | 'ready'; data: unknown } = { phase: 'loading', data: null };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: { phase: 'loading' | 'ready'; data: unknown }) {
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});

vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const state = react.useSyncExternalStore(page.subscribe, page.get, page.get) as PageState;
            return {
                phase: state.phase,
                data: state.data,
                empty: state.data ? state.data.jobs.length === 0 : false,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                retry: vi.fn(),
                refresh: vi.fn(),
                setData: vi.fn(),
            };
        },
    };
});

import { getEmployerProfile } from '@/lib/api/employer';
import type { EmployerProfileData } from '@/lib/api/employer';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { PostJobProvider } from '@/contexts/PostJobContext';
import EmployerDashboardPage from '../page';

type Locale = 'en' | 'es';

function renderDashboard(locale: Locale = 'en') {
    return render(
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <PostJobProvider>
                        <EmployerDashboardPage />
                    </PostJobProvider>
                </TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
}

/**
 * Several separate acts, each a short real wait: long enough for the lazily
 * loaded player to arrive, so "stays shut" means it was never asked for.
 */
async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
    }
}

/** A plan with an unusual limit, so a hard-coded number cannot pass. */
const plan = (activeJobLimit: number): EmployerBilling => ({
    planCode: 'employer_free',
    activeJobLimit,
    templateLimit: 1,
    activeJobUsage: 0,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
});

const anyJob = {
    id: 'job-1',
    title: 'Concrete Finisher',
    location: 'El Paso, TX',
    status: 'closed',
    applicant_count: 0,
    hired_count: 0,
    open_count: 0,
    created_at: '2026-08-01T00:00:00Z',
} as unknown as Job;

/*
 * Account creation dates either side of the tour's release (midnight
 * Mountain time on 2026-10-25, i.e. 06:00 UTC). Written out, not imported,
 * so these tests also run against a page that predates the rule.
 */
const CREATED_AFTER_RELEASE = '2026-10-25T06:00:00.000Z';
const CREATED_BEFORE_RELEASE = '2026-10-25T05:59:59.000Z';
const profileRead = vi.mocked(getEmployerProfile);
const profile = (created_at: string) => ({ id: 'e1', user_type: 'employer', created_at }) as unknown as EmployerProfileData;

const welcomeTitle = () => message('tutorial.employer_welcome.title');
const welcomeDialog = () => screen.queryByRole('dialog', { name: welcomeTitle() });
const tourDialog = () => screen.queryByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') });

const posts = () => tutorialCalls().filter(([method]) => method === 'POST').map(([, , body]) => body);

beforeAll(async () => {
    // The tour's lazy chunk, fetched once up front: a cold first import
    // would otherwise spend the first test's wait on module transforms.
    await import('@/components/tutorials/AppTourHost');
});

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element puts every stand-in control
    // on screen and keeps the dialogs' focus traps working.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    localStorage.clear();
    sessionStorage.clear();
    document.body.style.overflow = '';
    page.set({ phase: 'loading', data: null });
    signIn('employer');
    serveTutorials([]);
    profileRead.mockReset();
    profileRead.mockResolvedValue(profile(CREATED_AFTER_RELEASE));
});

describe('dashboard: the employer app tour', () => {
    it('plays for a new employer once the board is ready, then leaves them on the dashboard with no welcome slides', async () => {
        renderDashboard();
        await settle();
        expect(tourDialog()).toBeNull();

        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        expect(await screen.findByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') })).toBeTruthy();
        // One dialog at a time: E1 waits for the tour.
        expect(welcomeDialog()).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.tour.employer.start') }));
        });
        // The tour starts on the dashboard link, then the page's own "Post a job".
        expect(screen.getByRole('dialog', { name: message('employer_dashboard.nav.dashboard') })).toBeTruthy();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.common.next') }));
        });
        expect(screen.getByRole('dialog', { name: message('tutorial.tour.employer.post_job_title') })).toBeTruthy();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.common.skip') }));
        });

        await settle();
        expect(tourDialog()).toBeNull();
        expect(welcomeDialog()).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
        expect(posts()).toEqual([{ tutorial_id: 'employer_app_tour', outcome: 'skipped' }]);
    });

    it('leaves the welcome slides out after a tour the person finished, too', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        await screen.findByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') });
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.tour.employer.not_now') }));
        });
        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(posts()).toEqual([{ tutorial_id: 'employer_app_tour', outcome: 'skipped' }]);
    });

    it('marks one element only as the post-a-job target: the page’s header action', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        await screen.findByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') });

        const marked = document.querySelectorAll('[data-tour="post-job"]');
        expect(marked).toHaveLength(1);
        expect(marked[0].closest('header')).not.toBeNull();
    });

    it('keeps the welcome slides shut when the tour already has an outcome', async () => {
        serveTutorials([record('employer_app_tour', 'completed')]);
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));

        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(tourDialog()).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
        expect(posts()).toEqual([]);
    });

    it('keeps the welcome slides shut in "every time" mode once the tour has an outcome', async () => {
        serveTutorials({
            status: 200,
            body: { tutorials: [record('employer_app_tour', 'skipped')], settings: { always_show: true, muted: [] } },
        });
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));

        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    });

    it('plays neither for an employer who has a job', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [anyJob], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(tourDialog()).toBeNull();
        expect(welcomeDialog()).toBeNull();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
        expect(posts()).toEqual([]);
    });

    it('waits for the progress read when the board is ready first', async () => {
        let answer: (response: Response) => void = () => {};
        harnessFetch.mockImplementationOnce(
            () => new Promise<Response>((resolve) => {
                answer = resolve;
            }),
        );
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(tourDialog()).toBeNull();
        expect(welcomeDialog()).toBeNull();

        await act(async () => {
            answer(jsonResponse(200, { tutorials: [] }));
        });
        expect(await screen.findByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') })).toBeTruthy();
    });
});

describe('dashboard: the app tour is for accounts created since its release', () => {
    it('waits for the profile read before playing the tour for a new account', async () => {
        let answer: (value: EmployerProfileData) => void = () => {};
        profileRead.mockImplementation(
            () => new Promise<EmployerProfileData>((resolve) => {
                answer = resolve;
            }),
        );
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(tourDialog()).toBeNull();
        expect(welcomeDialog()).toBeNull();
        expect(profileRead).toHaveBeenCalledTimes(1);

        await act(async () => {
            answer(profile(CREATED_AFTER_RELEASE));
        });
        expect(await screen.findByRole('dialog', { name: message('tutorial.tour.employer.welcome_title') })).toBeTruthy();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.tour.employer.not_now') }));
        });
        await settle();
        expect(welcomeDialog()).toBeNull();
    });

    it('gives an older account with an empty board no tour, and asks about the welcome slides as before', async () => {
        profileRead.mockResolvedValue(profile(CREATED_BEFORE_RELEASE));
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));

        expect(await screen.findByRole('dialog', { name: welcomeTitle() }, { timeout: 5000 })).toBeTruthy();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('plays no tour when the profile read fails, and asks about the welcome slides as before', async () => {
        profileRead.mockRejectedValue(new Error('profile_fetch_failed'));
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));

        expect(await screen.findByRole('dialog', { name: welcomeTitle() }, { timeout: 5000 })).toBeTruthy();
        expect(tourDialog()).toBeNull();
    });

    it('reads no profile for an employer with a job', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [anyJob], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(profileRead).not.toHaveBeenCalled();
    });
});
