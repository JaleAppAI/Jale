// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { Applicant, EmployerJobDetail } from '@/lib/api/employer';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * Phase 3, Task 17, on the job page itself:
 *  - the owner's `JobAssigneeControl` sits in the job panel, is handed the
 *    job's responsible person, and reads the job again after a move;
 *  - "Message" on an applicant row answers a 409 `job_move_conflict` (the job
 *    was reassigned while the conversation was being created) with its own
 *    sentence, and reads the job and its applicants again. Flag off: unchanged.
 */

const startConversation = vi.fn();

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));

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
const editModal = vi.hoisted(() => ({ onJobUpdated: null as null | ((job: unknown) => void) }));
vi.mock('@/components/employer/EditJobModal', () => ({
    EditJobModal: (props: { onJobUpdated: (job: unknown) => void }) => {
        editModal.onJobUpdated = props.onJobUpdated;
        return null;
    },
}));
vi.mock('@/components/employer/PublicListingCard', () => ({ PublicListingCard: () => null }));
vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => null,
    EMPTY_APPLICANT_FILTERS: {},
    hasActiveApplicantFilters: () => false,
}));

/** The control's own behaviour is its suite's; here only what the page hands it. */
const assignee = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('@/components/employer/JobAssigneeControl', () => ({
    JobAssigneeControl: (props: Record<string, unknown>) => {
        assignee.props = props;
        return (
            <button type="button" onClick={() => (props.onJobChanged as () => void)()}>
                fake-assignee-moved
            </button>
        );
    },
}));

vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: () => ({
        maybeAutoOpen: vi.fn(),
        runBeforeHost: vi.fn((open: () => void) => open()),
        runWithHost: vi.fn((open: () => void) => open()),
        replay: vi.fn(),
    }),
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJob: vi.fn(),
    getJobApplicants: vi.fn(async () => ({ applicants: [] })),
    getJobCandidates: vi.fn(async () => ({ candidates: [] })),
    getJobs: vi.fn(async () => []),
    deleteJob: vi.fn(),
    startConversation: (...args: unknown[]) => startConversation(...args),
    updateApplicantStatus: vi.fn(),
    updateJobStatus: vi.fn(),
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

const refresh = vi.fn();
const pageState = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready',
        data: pageState.data,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh,
        // The page's writes land in the same state the fake reads.
        setData: (updater: (prev: unknown) => unknown) => {
            pageState.data = updater(pageState.data);
        },
    }),
}));

// Below every `vi.mock` on purpose (they hoist).
import { ApiError } from '@/lib/api/errors';
import EmployerJobDetailPage from '../page';

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const FOREMAN = 'aaaaaaaa-0000-4000-8000-000000000002';

const job = {
    id: JOB_ID,
    employer_id: FOREMAN,
    title: 'Helper',
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

const applicant = {
    application_id: 'app-1',
    worker_id: 'w-1',
    full_name: 'Maria Garcia',
    phone: null,
    status: 'pending',
    applied_at: '2026-06-02T15:00:00.000Z',
    skills: [],
    availability: null,
    years_experience: null,
    location: null,
} as unknown as Applicant;

function messageButton(): HTMLElement {
    return screen.getByRole('button', { name: message('employer_messages.message_worker') });
}

beforeEach(() => {
    vi.clearAllMocks();
    assignee.props = null;
    pageState.data = { job, applicants: [applicant], appliedFilters: {} };
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('job page: the owner reassignment control', () => {
    it('hands the control the job and its responsible person, and reads the job again after a move', () => {
        renderIntl(<EmployerJobDetailPage />);

        expect(assignee.props).toMatchObject({
            jobId: JOB_ID,
            assigneeUserId: FOREMAN,
            returnUrl: `/employer/jobs/${JOB_ID}`,
        });

        fireEvent.click(screen.getByRole('button', { name: 'fake-assignee-moved' }));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('passes null when the job read names no responsible person', () => {
        const withoutAssignee: Record<string, unknown> = { ...job };
        delete withoutAssignee.employer_id;
        pageState.data = { job: withoutAssignee, applicants: [], appliedFilters: {} };
        renderIntl(<EmployerJobDetailPage />);

        expect(assignee.props).toMatchObject({ assigneeUserId: null });
    });

    it('keeps the responsible person across an edit, whose answer does not carry it', () => {
        renderIntl(<EmployerJobDetailPage />);
        const edited: Record<string, unknown> = { ...job, title: 'Senior helper' };
        delete edited.employer_id;

        editModal.onJobUpdated!(edited);

        expect(pageState.data).toMatchObject({ job: { title: 'Senior helper', employer_id: FOREMAN } });
    });
});

describe('job page: messaging an applicant of a job that just moved', () => {
    it('says the job was reassigned, and reads the job and applicants again', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        startConversation.mockRejectedValue(new ApiError(409, 'job_move_conflict'));
        renderIntl(<EmployerJobDetailPage />);

        fireEvent.click(messageButton());

        expect(await screen.findByText(message('employer_team.errors.job_move_conflict'))).toBeInTheDocument();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(router.push).not.toHaveBeenCalled();
    });

    it('says it in Spanish too', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        startConversation.mockRejectedValue(new ApiError(409, 'job_move_conflict'));
        renderIntl(<EmployerJobDetailPage />, 'es');

        fireEvent.click(screen.getByRole('button', { name: message('employer_messages.message_worker', 'es') }));

        expect(await screen.findByText(message('employer_team.errors.job_move_conflict', 'es'))).toBeInTheDocument();
    });

    it('flag off: the same 409 reads as before, and nothing is re-read', async () => {
        startConversation.mockRejectedValue(new ApiError(409, 'job_move_conflict'));
        renderIntl(<EmployerJobDetailPage />);

        fireEvent.click(messageButton());

        await waitFor(() => expect(startConversation).toHaveBeenCalled());
        await waitFor(() => expect(messageButton()).not.toHaveAttribute('aria-busy'));
        expect(screen.queryByText(message('employer_team.errors.job_move_conflict'))).not.toBeInTheDocument();
        expect(refresh).not.toHaveBeenCalled();
    });
});
