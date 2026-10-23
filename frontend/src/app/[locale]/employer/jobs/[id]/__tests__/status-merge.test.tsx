// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { EmployerJobDetail } from '@/lib/api/employer';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * K2 (2026-10-22): a status-only PATCH (pause, resume, close) answers without
 * `shift_periods`. Merging that answer into the page must keep the job's shift
 * choices, not read the missing key as "no shifts".
 */

const updateJobStatus = vi.fn();

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
    updateJobStatus: (...args: unknown[]) => updateJobStatus(...args),
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
/** The page's optimistic writes land in the same store the fake reads. */
const setData = (updater: (prev: unknown) => unknown) =>
    page.set({ phase: 'ready', data: updater(page.get().data) });
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
                setData,
            };
        },
    };
});

// Below every `vi.mock` on purpose (they hoist).
import EmployerJobDetailPage from '../page';

const job = {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Helper',
    location: 'Austin, TX',
    pay: null,
    job_type: 'full-time',
    status: 'active',
    applicant_count: 0,
    hired_count: 0,
    open_count: 0,
    hire_details_needed_count: 0,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    shift_periods: ['evening'],
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

/** The schedule tile's value, or null when the tile is not shown. */
function scheduleTile(): string | null {
    const label = message('employer_dashboard.modal.shift_schedule');
    const tile = Array.from(document.querySelectorAll('dl > div')).find(
        (row) => row.querySelector('dt')?.textContent === label,
    );
    return tile?.querySelector('dd')?.textContent ?? null;
}

beforeEach(() => {
    vi.clearAllMocks();
    page.set({ phase: 'ready', data: { job, applicants: [], appliedFilters: {} } });
    inbox.set({ loading: false, errorKind: null, items: [] });
});

describe('job page: a status change keeps the shift choices', () => {
    it('still shows the shifts after a pause whose answer omits them', async () => {
        // The status-only answer: no shift_periods key at all.
        updateJobStatus.mockResolvedValue({ id: job.id, title: job.title, status: 'paused' });
        renderIntl(<EmployerJobDetailPage />);
        expect(scheduleTile()).toBe(message('common.shift_periods.evening'));

        fireEvent.click(screen.getByRole('button', { name: message('employer_job_listing.actions.pause') }));

        await waitFor(() => expect(updateJobStatus).toHaveBeenCalledWith('test-token', job.id, 'paused'));
        await waitFor(() =>
            expect((page.get().data as { job: { status: string } }).job.status).toBe('paused'));
        expect(scheduleTile()).toBe(message('common.shift_periods.evening'));
    });
});
