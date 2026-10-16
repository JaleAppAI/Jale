// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { Job } from '@/lib/api/employer';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => (
        <div>
            <div data-testid="shell-actions">{actions}</div>
            {children}
        </div>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}));

// Stubbed to a marker: whether the WIZARD opens is the assertion, and the real
// one drags in the whole three-step form plus two background fetches.
vi.mock('@/components/employer/PostJobModal', () => ({
    PostJobModal: ({ open }: { open: boolean }) =>
        open ? <div data-testid="post-job-wizard" /> : null,
}));

const updateJobStatus = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: vi.fn(),
    getBilling: vi.fn(),
    listJobTemplates: vi.fn(),
    deleteJob: vi.fn(),
    updateJobStatus: (...args: unknown[]) => updateJobStatus(...args),
}));

type DashboardData = { jobs: Job[]; billing: null; templateCount: number | null };

/** Assigned by each test before rendering; the fake hook seeds itself from it. */
let seed: DashboardData;

// The dashboard's WhatsApp panel reads the session-wide inbox. These suites
// replace `usePageData` with a dashboard-shaped fake, so the real provider
// would be handed the dashboard's own fixture -- the context is stubbed empty
// instead, which is the state a board with no messages renders in anyway.
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

vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const [data, setState] = react.useState<DashboardData>(() => seed);
            return {
                phase: 'ready' as const,
                data,
                empty: data.jobs.length === 0,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                retry: vi.fn(),
                refresh: vi.fn(),
                setData: (updater: (prev: DashboardData) => DashboardData) =>
                    setState((prev) => updater(prev)),
            };
        },
    };
});

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { PostJobProvider } from '@/contexts/PostJobContext';
import EmployerDashboardPage from '../page';

function job(over: Partial<Job>): Job {
    return {
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
        hire_details_needed_count: 0,
        ...over,
    };
}

function bannerText(count: number): string {
    const raw = message('employer_applicants.hire_details.banner');
    const form = count === 1 ? /one \{([^}]*)\}/ : /other \{([^}]*)\}/;
    return (raw.match(form)?.[1] ?? '').replace(/#/g, String(count));
}

function renderBoard(jobs: Job[]) {
    seed = { jobs, billing: null, templateCount: null };
    return renderIntl(<PostJobProvider><EmployerDashboardPage /></PostJobProvider>);
}

describe('dashboard: start details owed to new hires', () => {
    it('adds up every job\'s hires that still need start details, and links to the applicants', () => {
        renderBoard([
            job({ id: 'job-1', hire_details_needed_count: 1 }),
            job({ id: 'job-2', hire_details_needed_count: 2 }),
        ]);

        expect(screen.getByText(bannerText(3))).toBeInTheDocument();
        expect(screen.getByRole('link', { name: message('employer_applicants.hire_details.banner_cta') }))
            .toHaveAttribute('href', '/employer/applicants');
    });

    it('shows nothing when no hire is waiting', () => {
        renderBoard([
            job({ id: 'job-1', hire_details_needed_count: 0 }),
            job({ id: 'job-2', hire_details_needed_count: 0 }),
        ]);
        expect(screen.queryByText(bannerText(1))).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: message('employer_applicants.hire_details.banner_cta') })).not.toBeInTheDocument();
    });
});
