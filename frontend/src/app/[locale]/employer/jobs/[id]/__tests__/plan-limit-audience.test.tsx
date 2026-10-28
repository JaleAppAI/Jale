// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import type { EmployerJobDetail } from '@/lib/api/employer';
import type { MembershipInfo } from '@/lib/api/team';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * Phase 3 (Task 17b): resuming a paused job refused by the plan (403
 * job_limit_reached) speaks to who is resuming, as the dashboard and the
 * modals already do. A foreman is told to ask the owner and a Pro owner how
 * to free a slot; neither is offered Upgrade. A Free owner keeps it, and with
 * the flag off the dialog is Phase 2's and no membership request is made.
 *
 * The REAL membership hook runs here, over a stubbed `getMembership`, so the
 * flag-off case can assert that no request leaves the page.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));

const requireAuth = {
    idToken: 'test-token',
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
vi.mock('@/components/employer/JobAssigneeControl', () => ({ JobAssigneeControl: () => null }));
vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => null,
    EMPTY_APPLICANT_FILTERS: {},
    hasActiveApplicantFilters: () => false,
}));

vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: () => ({
        maybeAutoOpen: vi.fn(),
        runBeforeHost: vi.fn((open: () => void) => open()),
        runWithHost: vi.fn((open: () => void) => open()),
        replay: vi.fn(),
    }),
}));

const updateJobStatus = vi.fn();
const getBilling = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJob: vi.fn(),
    getJobApplicants: vi.fn(async () => ({ applicants: [] })),
    getJobCandidates: vi.fn(async () => ({ candidates: [] })),
    getJobs: vi.fn(async () => []),
    getBilling: (...args: unknown[]) => getBilling(...args),
    updateJobStatus: (...args: unknown[]) => updateJobStatus(...args),
}));

const getMembership = vi.fn();
vi.mock('@/lib/api/team', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/team')>()),
    getMembership: (...args: unknown[]) => getMembership(...args),
}));

vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        loading: false,
        errorKind: null,
        items: [],
        unreadCount: 0,
        unreadByConversation: {},
        retry: vi.fn(),
        refresh: vi.fn(),
        markRead: vi.fn(),
    }),
    useUnreadCount: () => 0,
}));

const pageState = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready',
        data: pageState.data,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: (updater: (prev: unknown) => unknown) => {
            pageState.data = updater(pageState.data);
        },
    }),
}));

// Below every `vi.mock` on purpose (they hoist).
import { ApiError } from '@/lib/api/errors';
import { clearEmployerMembershipCache } from '@/hooks/useEmployerMembership';
import { getJobs } from '@/lib/api/employer';
import EmployerJobDetailPage from '../page';

const JOB_ID = '11111111-2222-4333-8444-555555555555';

const pausedJob = {
    id: JOB_ID,
    employer_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    title: 'Helper',
    location: 'Austin, TX',
    pay: null,
    job_type: 'full-time',
    status: 'paused',
    applicant_count: 0,
    hired_count: 0,
    open_count: 1,
    hire_details_needed_count: 0,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    shift_periods: [],
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

const member = (role: 'owner' | 'foreman'): MembershipInfo => ({
    userId: 'u1', organizationId: 'o1', role, companyName: 'Bravo',
});

const limit403 = (planCode: string) =>
    new ApiError(403, 'job_limit_reached', { active_job_limit: 3, active_jobs: 3, plan_code: planCode });

const upgradeLink = () => screen.queryByRole('link', { name: message('billing.limit_dialog.cta_upgrade') });

/** Renders, lets the membership read settle, then presses Resume. */
async function resume() {
    renderIntl(<EmployerJobDetailPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: message('employer_job_listing.actions.activate') }));
}

beforeEach(() => {
    vi.clearAllMocks();
    clearEmployerMembershipCache();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    pageState.data = { job: pausedJob, applicants: [], appliedFilters: {} };
    getMembership.mockResolvedValue(member('owner'));
    getBilling.mockRejectedValue(new Error('not expected'));
    vi.mocked(getJobs).mockResolvedValue([]);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('job page: a refused resume by who is resuming', () => {
    it('a foreman is told to ask the owner, with no Upgrade', async () => {
        getMembership.mockResolvedValue(member('foreman'));
        updateJobStatus.mockRejectedValue(limit403('employer_free'));

        await resume();

        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument());
        expect(upgradeLink()).toBeNull();
        expect(screen.getByRole('link', { name: message('billing.limit_dialog.cta_pause_job') })).toBeInTheDocument();
    });

    it('a Pro owner (plan read off the 403) gets the Pro hint, with no Upgrade', async () => {
        updateJobStatus.mockRejectedValue(limit403('employer_pro'));

        await resume();

        await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.pro_owner_hint'))).toBeInTheDocument());
        expect(upgradeLink()).toBeNull();
        expect(screen.queryByText(message('billing.limit_dialog.hint_jobs'))).toBeNull();
    });

    it('a Free owner keeps Upgrade', async () => {
        updateJobStatus.mockRejectedValue(limit403('employer_free'));

        await resume();

        await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
        expect(screen.getByText(message('billing.limit_dialog.hint_jobs'))).toBeInTheDocument();
    });

    it('the audience survives the jobs list that fills the dialog in', async () => {
        getMembership.mockResolvedValue(member('foreman'));
        updateJobStatus.mockRejectedValue(limit403('employer_free'));
        vi.mocked(getJobs).mockResolvedValue([
            { id: 'job-old', title: 'Framer', status: 'active', created_at: '2026-05-01T00:00:00.000Z' },
        ] as unknown as Awaited<ReturnType<typeof getJobs>>);

        await resume();
        // The detached getJobs() recomputes the model; it must keep the reader.
        await waitFor(() => expect(getJobs).toHaveBeenCalled());
        await act(async () => {});

        // The refill landed (it names the job holding the slot) ...
        expect(screen.getByText('Framer')).toBeInTheDocument();
        // ... and the reader is still the foreman.
        expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument();
        expect(upgradeLink()).toBeNull();
    });

    it('a foreman on a Pro company is not told to ask for an upgrade', async () => {
        getMembership.mockResolvedValue(member('foreman'));
        updateJobStatus.mockRejectedValue(limit403('employer_pro'));

        await resume();

        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.foreman_body_pro'), { exact: false })).toBeInTheDocument());
        expect(screen.queryByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeNull();
        expect(upgradeLink()).toBeNull();
    });

    it('flag off: Phase 2 copy, and no membership request', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        getMembership.mockResolvedValue(member('foreman'));
        updateJobStatus.mockRejectedValue(limit403('employer_pro'));

        await resume();

        await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
        expect(screen.getByText(message('billing.limit_dialog.hint_jobs'))).toBeInTheDocument();
        expect(screen.queryByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeNull();
        expect(getMembership).not.toHaveBeenCalled();
        expect(getBilling).not.toHaveBeenCalled();
    });
});
