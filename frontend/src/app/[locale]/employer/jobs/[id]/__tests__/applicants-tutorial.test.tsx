// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

import type { Applicant, EmployerJobDetail, InboxItem } from '@/lib/api/employer';
import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * E3 (sprint 29): the applicants tutorial auto-opens the first time an
 * employer opens a job's applicants -- this page, when it has any -- unless one
 * of their applications is already past applied (K1.5), as this page or the
 * inbox shows it. The real tutorial lands with the framework; here the hook is
 * a recording handle.
 */

const tutorial = vi.hoisted(() => {
    const latestDone: Record<string, boolean | undefined> = {};
    const ids = new Set<string>();
    const handle = { maybeAutoOpen: vi.fn(), runBeforeHost: vi.fn((openHost: () => void) => openHost()), replay: vi.fn() };
    return { latestDone, ids, handle };
});
vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: (id: string, options: { done: boolean | undefined }) => {
        tutorial.ids.add(id);
        tutorial.latestDone[id] = options.done;
        return tutorial.handle;
    },
}));

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));

// Stable identities: the page's effects list these in their deps.
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => router,
}));

const auth = { idToken: 'test-token' };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const requireAuth = {
    handleLegalWall: (err: unknown) => {
        throw err;
    },
};
vi.mock('@/hooks/useRequireAuth', () => ({ useRequireAuth: () => requireAuth }));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/AppShellSkeleton', () => ({
    AppShellSkeleton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/employer/EditJobModal', () => ({ EditJobModal: () => null }));
vi.mock('@/components/employer/PublicListingCard', () => ({ PublicListingCard: () => null }));
vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => null,
    EMPTY_APPLICANT_FILTERS: {},
    hasActiveApplicantFilters: () => false,
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJob: vi.fn(),
    getJobApplicants: vi.fn(async () => ({ applicants: [] })),
    getJobCandidates: vi.fn(async () => []),
    getJobs: vi.fn(async () => []),
    deleteJob: vi.fn(),
    startConversation: vi.fn(),
    updateApplicantStatus: vi.fn(),
    updateJobStatus: vi.fn(),
}));

/** The session-wide inbox, driven from the test. */
const inbox = vi.hoisted(() => {
    let state: { loading: boolean; errorKind: string | null; items: unknown[] } = { loading: true, errorKind: null, items: [] };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
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
const inboxActions = { retry: vi.fn(), refresh: vi.fn(), markRead: vi.fn() };
vi.mock('@/contexts/UnreadMessagesContext', async () => {
    const react = await import('react');
    return {
        useUnreadMessages: () => {
            const state = react.useSyncExternalStore(inbox.subscribe, inbox.get, inbox.get);
            return { ...state, unreadCount: 0, unreadByConversation: {}, ...inboxActions };
        },
        useUnreadCount: () => 0,
    };
});

/** The page's own load, driven from the test. */
const page = vi.hoisted(() => {
    let state: { phase: 'loading' | 'ready'; data: unknown } = { phase: 'loading', data: null };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
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
const noop = vi.fn();
vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const state = react.useSyncExternalStore(page.subscribe, page.get, page.get);
            return {
                phase: state.phase,
                data: state.data,
                errorKind: null,
                refreshing: false,
                refreshError: false,
                retry: noop,
                refresh: noop,
                setData: noop,
            };
        },
    };
});

// Below every `vi.mock` on purpose (they hoist).
import EmployerJobDetailPage from '../page';

const job = {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Drywall Finisher',
    location: 'Austin, TX',
    pay: null,
    job_type: 'full-time',
    status: 'active',
    applicant_count: 1,
    hired_count: 0,
    open_count: 1,
    hire_details_needed_count: 0,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    transportation_required: false,
    work_authorization_required: false,
    language_preference: [],
    number_of_workers_needed: 1,
    trade_category: null,
    required_experience_years: null,
    required_experience_months: null,
    certifications: [],
    created_at: '2026-06-01T15:00:00.000Z',
    description: null,
    required_docs: [],
    public_code: 'ABC123',
    public_listing_enabled: false,
} as unknown as EmployerJobDetail;

function applicant(status: Applicant['status'], n = 1): Applicant {
    return {
        application_id: `app-${n}`,
        worker_id: `00000000-0000-4000-8000-00000000000${n}`,
        full_name: 'Test Worker',
        phone: null,
        status,
        applied_at: '2026-06-02T15:00:00.000Z',
        skills: [],
        availability: null,
        years_experience: null,
        location: null,
        hire_details: null,
        hire_details_needed: false,
    };
}

const inboxRow = (application_status: InboxItem['application_status']) =>
    ({ application_id: 'app-other', application_status, conversation_id: null }) as unknown as InboxItem;

const ready = (applicants: Applicant[]) =>
    page.set({ phase: 'ready', data: { job, applicants, appliedFilters: {} } });

beforeEach(() => {
    vi.clearAllMocks();
    for (const id of Object.keys(tutorial.latestDone)) delete tutorial.latestDone[id];
    tutorial.ids.clear();
    page.set({ phase: 'loading', data: null });
    inbox.set({ loading: true, errorKind: null, items: [] });
});

describe('job page: the applicants tutorial', () => {
    it('waits for the page and the inbox, then asks once when the job has applicants', () => {
        renderIntl(<EmployerJobDetailPage />);
        expect(tutorial.ids.has('employer_applicants')).toBe(true);
        expect(tutorial.latestDone.employer_applicants).toBeUndefined();

        act(() => ready([applicant('pending')]));
        // The page shows nothing past applied, and the inbox is still loading.
        expect(tutorial.latestDone.employer_applicants).toBeUndefined();
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();

        act(() => inbox.set({ loading: false, errorKind: null, items: [inboxRow('talking')] }));
        expect(tutorial.latestDone.employer_applicants).toBe(false);
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);

        act(() => inbox.set({ loading: false, errorKind: null, items: [inboxRow('contacted')] }));
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });

    it('does not ask on a job with no applicants', () => {
        renderIntl(<EmployerJobDetailPage />);
        act(() => {
            ready([]);
            inbox.set({ loading: false, errorKind: null, items: [] });
        });

        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('passes done true when an applicant on this page is past applied', () => {
        renderIntl(<EmployerJobDetailPage />);
        act(() => ready([applicant('pending', 1), applicant('details_requested', 2)]));

        expect(tutorial.latestDone.employer_applicants).toBe(true);
    });

    it('passes done true when the inbox shows a hire on another job', () => {
        renderIntl(<EmployerJobDetailPage />);
        act(() => {
            ready([applicant('pending')]);
            inbox.set({ loading: false, errorKind: null, items: [inboxRow('hired')] });
        });

        expect(tutorial.latestDone.employer_applicants).toBe(true);
    });

    it('answers from the page alone when the inbox read failed', () => {
        renderIntl(<EmployerJobDetailPage />);
        act(() => {
            ready([applicant('contacted')]);
            inbox.set({ loading: false, errorKind: 'network', items: [] });
        });

        expect(tutorial.latestDone.employer_applicants).toBe(false);
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });
});
