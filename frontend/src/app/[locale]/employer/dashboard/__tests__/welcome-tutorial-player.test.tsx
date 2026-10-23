// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { EmployerBilling, Job } from '@/lib/api/employer';
import { message } from '@/components/worker/onboarding/__tests__/render-intl';
import { record, resetHarness, serveTutorials, signIn, tutorialCalls, catalogues } from '@/lib/tutorials/__tests__/harness';

/*
 * E1 with the real tutorial machinery: the progress store, the overlay
 * coordinator, the lazily loaded player and the real welcome tour. The
 * dashboard's own data and the wizard are stand-ins; the tutorial is not.
 *
 *  - It auto-opens once the board is ready, for an employer with no job yet
 *    and no outcome on record (K1.5), and its last slide reads the limit from
 *    the plan snapshot the board loaded.
 *  - It stays shut for an employer with a job, or one who already finished
 *    or skipped it.
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
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

/** Two separate acts: the second commits whatever the first one's promises woke up. */
async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
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

const welcomeTitle = (locale: Locale = 'en') => message('tutorial.employer_welcome.title', locale);
const welcomeDialog = (locale: Locale = 'en') => screen.queryByRole('dialog', { name: welcomeTitle(locale) });

/** Presses the primary button until the last slide, and returns what the scene there says. */
function toLastSlide(locale: Locale = 'en') {
    const next = message('tutorial.common.next', locale);
    for (let turn = 0; turn < 4; turn += 1) {
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: next }));
        });
    }
    const dialog = welcomeDialog(locale);
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByRole('heading', { level: 2 }).textContent).toBe(
        message('tutorial.employer_welcome.slides.hire.title', locale),
    );
    return dialog?.textContent ?? '';
}

const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
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
});

describe('dashboard: the real welcome tour', () => {
    it('opens once the board is ready for an employer with no job, shows the plan snapshot’s limit, and records the finish', async () => {
        renderDashboard();
        await settle();
        expect(welcomeDialog()).toBeNull();

        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        expect(await screen.findByRole('dialog', { name: welcomeTitle() })).toBeTruthy();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

        expect(toLastSlide()).toContain('Your plan: up to 7 active jobs');

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: message('tutorial.common.got_it') }));
        });
        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_welcome', outcome: 'completed' }]);
    });

    it('reads the limit in Spanish too', async () => {
        renderDashboard('es');
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(1), templateCount: 0 } }));
        expect(await screen.findByRole('dialog', { name: welcomeTitle('es') })).toBeTruthy();
        expect(toLastSlide('es')).toContain('Su plan: hasta 1 empleo activo');
    });

    it('leaves the plan line out when the plan could not be read', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: null, templateCount: 0 } }));
        expect(await screen.findByRole('dialog', { name: welcomeTitle() })).toBeTruthy();
        expect(toLastSlide()).not.toMatch(/your plan|active job/i);
    });

    it('stays shut for an employer who already has a job', async () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [anyJob], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('stays shut once it was finished or skipped before', async () => {
        serveTutorials([record('employer_welcome', 'skipped')]);
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        await settle();
        expect(welcomeDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });
});
