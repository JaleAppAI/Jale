// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@/lib/api/errors';
import type { EmployerBilling, Job } from '@/lib/api/employer';

/*
 * Phase 3 (Task 14) on the dashboard:
 *  - signage is the owner's: a foreman cannot act on "upgrade" or "re-subscribe",
 *    so they get no SubscriptionBanner;
 *  - the template meter counts the COMPANY's templates (`billing.templateUsage`);
 *  - a refused resume tells a foreman to ask their owner, with no Upgrade CTA.
 *
 * Unlike the other dashboard suites, `usePageData` here RUNS the page's own
 * fetcher, so the template count is the one the page really derives from its
 * three calls.
 */

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

const { getJobs, getBilling, listJobTemplates, updateJobStatus } = vi.hoisted(() => ({
    getJobs: vi.fn(),
    getBilling: vi.fn(),
    listJobTemplates: vi.fn(),
    updateJobStatus: vi.fn(),
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: (...args: unknown[]) => getJobs(...args),
    getBilling: (...args: unknown[]) => getBilling(...args),
    listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
    deleteJob: vi.fn(),
    updateJobStatus: (...args: unknown[]) => updateJobStatus(...args),
}));

vi.mock('@/lib/employer-profile-flush', () => ({
    flushPendingEmployerProfile: vi.fn(() => Promise.resolve()),
    loadEmployerProfileWithPendingFlush: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        items: [],
        unreadCount: 0,
        unreadByConversation: {},
        loading: false,
        errorKind: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        markRead: vi.fn(),
    }),
    useUnreadCount: () => 0,
}));

/*
 * The membership, controllable. `loading` by default: the tests above it then
 * read the role billing names (the hook's fallback while membership is unknown).
 */
const { membershipState } = vi.hoisted(() => ({
    membershipState: { value: { status: 'loading' } as import('@/lib/employer-membership-store').EmployerMembership },
}));
vi.mock('@/hooks/useEmployerMembership', () => ({
    useEmployerMembership: () => membershipState.value,
}));

/** A `usePageData` that runs the page's fetcher once and serves its answer. */
vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: ({ fetcher }: { fetcher: (args: { token: string; signal: AbortSignal }) => Promise<unknown> }) => {
            const [data, setState] = react.useState<unknown>(null);
            react.useEffect(() => {
                void fetcher({ token: 'test-token', signal: new AbortController().signal }).then(setState);
            }, []);
            return {
                phase: data === null ? ('loading' as const) : ('ready' as const),
                data,
                empty: false,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                retry: vi.fn(),
                refresh: vi.fn(),
                setData: (updater: (prev: unknown) => unknown) => setState((prev: unknown) => updater(prev)),
            };
        },
    };
});

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { PostJobProvider } from '@/contexts/PostJobContext';
import EmployerDashboardPage from '../page';

function renderDashboard() {
    return renderIntl(
        <PostJobProvider>
            <EmployerDashboardPage />
        </PostJobProvider>,
    );
}

const activeJob: Job = {
    id: 'job-1',
    title: 'Concrete Finisher',
    location: 'El Paso, TX',
    pay: null,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    job_type: 'full-time',
    status: 'active',
    applicant_count: 2,
    hired_count: 0,
    open_count: 1,
    hire_details_needed_count: 0,
    number_of_workers_needed: 1,
    trade_category: 'concrete',
    created_at: '2026-08-01T00:00:00Z',
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    transportation_required: false,
    work_authorization_required: false,
    language_preference: ['any'],
    required_experience_years: null,
    required_experience_months: null,
    certifications: [],
};

const freePlan: EmployerBilling = {
    planCode: 'employer_free',
    activeJobLimit: 3,
    templateLimit: 6,
    activeJobUsage: 1,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

const freeTitle = () => message('billing.signage.free_title');

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    membershipState.value = { status: 'loading' };
    getJobs.mockResolvedValue([activeJob]);
    getBilling.mockResolvedValue({ ...freePlan, role: 'owner' });
    listJobTemplates.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('dashboard: Phase 3 roles and company counts', () => {
    it('no SubscriptionBanner for a foreman', async () => {
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman', seats: null });
        renderDashboard();

        await waitFor(() => expect(screen.getByText('Templates 2/6')).toBeInTheDocument());
        expect(screen.queryByText(freeTitle())).toBeNull();
    });

    it('the owner keeps the SubscriptionBanner', async () => {
        renderDashboard();
        await waitFor(() => expect(screen.getByText(freeTitle())).toBeInTheDocument());
    });

    it('flag off: a foreman row still gets Phase 2\'s banner', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman', seats: null });
        renderDashboard();
        await waitFor(() => expect(screen.getByText(freeTitle())).toBeInTheDocument());
    });

    it('meter templates come from billing.templateUsage', async () => {
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman', templateUsage: 5 });
        renderDashboard();

        await waitFor(() => expect(screen.getByText('Templates 5/6')).toBeInTheDocument());
    });

    it('meter templates fall back to the list count when billing has no templateUsage', async () => {
        renderDashboard();
        await waitFor(() => expect(screen.getByText('Templates 2/6')).toBeInTheDocument());
    });

    it('flag off: the meter counts the list, as in Phase 2', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        getBilling.mockResolvedValue({ ...freePlan, templateUsage: 5 });
        renderDashboard();
        await waitFor(() => expect(screen.getByText('Templates 2/6')).toBeInTheDocument());
    });

    it('a foreman\'s refused resume says to ask the owner, with no Upgrade CTA', async () => {
        getJobs.mockResolvedValue([{ ...activeJob, status: 'paused' }]);
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman', seats: null });
        updateJobStatus.mockRejectedValue(
            new ApiError(403, 'job_limit_reached', { active_job_limit: 3, active_jobs: 3, plan_code: 'employer_free' }),
        );
        renderDashboard();

        const resume = await screen.findByRole('button', {
            name: interpolate(message('employer_dashboard.jobs.status_change.resume_aria'), { title: activeJob.title }),
        });
        fireEvent.click(resume);

        await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument());
        expect(screen.queryByRole('link', { name: message('billing.limit_dialog.cta_upgrade') })).toBeNull();
        expect(screen.queryByRole('button', { name: message('billing.limit_dialog.cta_upgrade') })).toBeNull();
    });

    it('a foreman\'s meter has no "View plan"; an owner\'s keeps it', async () => {
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman', seats: null });
        const foreman = renderDashboard();
        await waitFor(() => expect(screen.getByText('Templates 2/6')).toBeInTheDocument());
        expect(screen.queryByRole('link', { name: message('employer_dashboard.usage.view_plan') })).toBeNull();
        foreman.unmount();

        getBilling.mockResolvedValue({ ...freePlan, role: 'owner' });
        renderDashboard();
        await waitFor(() => expect(screen.getByRole('link', { name: message('employer_dashboard.usage.view_plan') })).toBeInTheDocument());
    });

    it('billing null, membership says foreman: the membership role wins', async () => {
        membershipState.value = { status: 'ready', role: 'foreman', companyName: 'Bravo', userId: 'u2', organizationId: 'o1' };
        getJobs.mockResolvedValue([{ ...activeJob, status: 'paused' }]);
        getBilling.mockRejectedValue(new Error('billing down'));
        updateJobStatus.mockRejectedValue(
            new ApiError(403, 'job_limit_reached', { active_job_limit: 3, active_jobs: 3, plan_code: 'employer_free' }),
        );
        renderDashboard();

        const resume = await screen.findByRole('button', {
            name: interpolate(message('employer_dashboard.jobs.status_change.resume_aria'), { title: activeJob.title }),
        });
        // The plain count (no billing) without the owner's "View plan".
        expect(screen.queryByRole('link', { name: message('employer_dashboard.usage.view_plan') })).toBeNull();
        fireEvent.click(resume);

        await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument());
        expect(screen.queryByRole('link', { name: message('billing.limit_dialog.cta_upgrade') })).toBeNull();
    });

    it('membership owner beats a billing row that says foreman', async () => {
        membershipState.value = { status: 'ready', role: 'owner', companyName: 'Bravo', userId: 'u1', organizationId: 'o1' };
        getBilling.mockResolvedValue({ ...freePlan, role: 'foreman' });
        renderDashboard();
        await waitFor(() => expect(screen.getByText(freeTitle())).toBeInTheDocument());
    });
});
