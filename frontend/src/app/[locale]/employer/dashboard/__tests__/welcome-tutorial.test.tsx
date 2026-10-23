// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

import type { EmployerBilling, Job } from '@/lib/api/employer';

/*
 * E1 (sprint 29): the welcome tutorial auto-opens on the dashboard once the
 * board has loaded, for an employer with no job yet (K1.5), and its plan line
 * reads the plan's real active-job limit. The real tutorial lands with the
 * framework; here the hook is a recording handle per tutorial id.
 */

const tutorial = vi.hoisted(() => {
    type Handle = { maybeAutoOpen: ReturnType<typeof vi.fn>; runBeforeHost: ReturnType<typeof vi.fn>; replay: ReturnType<typeof vi.fn> };
    const handles: Record<string, Handle> = {};
    const latestDone: Record<string, boolean | undefined> = {};
    const ids = new Set<string>();
    const handleFor = (id: string): Handle => {
        handles[id] ??= {
            maybeAutoOpen: vi.fn(),
            runBeforeHost: vi.fn((openHost: () => void) => openHost()),
            replay: vi.fn(),
        };
        return handles[id];
    };
    return { handles, latestDone, ids, handleFor };
});
vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: (id: string, options: { done: boolean | undefined }) => {
        tutorial.ids.add(id);
        tutorial.latestDone[id] = options.done;
        return tutorial.handleFor(id);
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token', userType: 'employer', isAuthenticated: true }),
}));

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

import { renderIntl } from '@/components/employer/__tests__/render-intl';
import { PostJobProvider } from '@/contexts/PostJobContext';
import EmployerDashboardPage from '../page';

function renderDashboard() {
    return renderIntl(
        <PostJobProvider>
            <EmployerDashboardPage />
        </PostJobProvider>,
    );
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

const welcome = () => tutorial.handleFor('employer_welcome');

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    for (const id of Object.keys(tutorial.latestDone)) delete tutorial.latestDone[id];
    tutorial.ids.clear();
    page.set({ phase: 'loading', data: null });
});

describe('dashboard: the welcome tutorial', () => {
    it('waits while the board loads, then asks once with the plan limit for an employer with no jobs', () => {
        renderDashboard();

        expect(tutorial.ids.has('employer_welcome')).toBe(true);
        expect(tutorial.latestDone.employer_welcome).toBeUndefined();
        expect(welcome().maybeAutoOpen).not.toHaveBeenCalled();

        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));

        expect(tutorial.latestDone.employer_welcome).toBe(false);
        expect(welcome().maybeAutoOpen).toHaveBeenCalledTimes(1);
        expect(welcome().maybeAutoOpen).toHaveBeenCalledWith({ activeJobLimit: 7 });
    });

    it('passes done true for an employer with a job in any status', () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [anyJob], billing: plan(7), templateCount: 0 } }));

        expect(tutorial.latestDone.employer_welcome).toBe(true);
    });

    it('asks with no plan values when the plan could not be read', () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: null, templateCount: 0 } }));

        expect(welcome().maybeAutoOpen).toHaveBeenCalledTimes(1);
        expect(welcome().maybeAutoOpen.mock.calls[0]).toEqual([]);
    });

    it('asks once per page view, not on every reload of the board', () => {
        renderDashboard();
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(7), templateCount: 0 } }));
        act(() => page.set({ phase: 'ready', data: { jobs: [], billing: plan(9), templateCount: 1 } }));

        expect(welcome().maybeAutoOpen).toHaveBeenCalledTimes(1);
    });
});
