// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { EmployerBilling, Job } from '@/lib/api/employer';

/*
 * The four stat cards' HINTS -- the small line under each number that says
 * what the number is about.
 *
 * "Workers Hired" carried "{count} openings still available", counted from
 * `open_count`. Openings are what is NOT hired, so the card's own number and
 * its hint measured opposite things, and the sentence belonged to the Active
 * Jobs card all along. Hired now carries its own progress (the same pair the
 * Job Progress bar draws) and Active Jobs takes the openings line.
 */

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

type DashboardData = { jobs: Job[]; billing: EmployerBilling | null; templateCount: number | null };

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

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
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
        ...over,
    };
}

const paidPlan: EmployerBilling = {
    planCode: 'employer_pro',
    activeJobLimit: 10,
    templateLimit: 5,
    activeJobUsage: 2,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

const stat = (key: string) => message(`employer_dashboard.stats.${key}`);

/** The hint line sits next to its own card's label inside one metric block. */
function hintUnder(label: string): string {
    const card = screen.getByText(label).parentElement!;
    return card.lastElementChild?.textContent ?? '';
}

beforeEach(() => {
    vi.clearAllMocks();
    // 1 of 5 positions filled across the two active jobs, 4 still open.
    seed = {
        jobs: [
            job({ id: 'job-1', hired_count: 1, open_count: 2, number_of_workers_needed: 3 }),
            job({ id: 'job-2', hired_count: 0, open_count: 2, number_of_workers_needed: 2 }),
        ],
        billing: paidPlan,
        templateCount: 0,
    };
});

describe('dashboard stat hints', () => {
    it('gives the Workers Hired card its own progress, not the openings count', () => {
        renderIntl(
            <PostJobProvider>
                <EmployerDashboardPage />
            </PostJobProvider>,
        );

        expect(hintUnder(stat('workers_hired'))).toBe(
            interpolate(stat('hired_hint'), { hired: 1, needed: 5 }),
        );
        expect(hintUnder(stat('workers_hired'))).toBe('1 of 5 positions filled');
    });

    it('moves the openings sentence to the Active Jobs card', () => {
        renderIntl(
            <PostJobProvider>
                <EmployerDashboardPage />
            </PostJobProvider>,
        );

        expect(hintUnder(stat('active_jobs'))).toBe(
            interpolate(stat('active_hint'), { count: 4 }),
        );
        expect(hintUnder(stat('active_jobs'))).toBe('4 openings still available');
    });
});
