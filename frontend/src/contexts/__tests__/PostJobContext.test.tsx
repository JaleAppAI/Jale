// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * "Post a job" was reachable from exactly one page. Every other employer
 * surface -- applicants, templates, messages, billing, a job's own page -- was
 * a dead end for the thing employers come here to do, because the wizard, its
 * plan-limit preflight and the "a job was posted" fan-out were all owned by the
 * dashboard component.
 *
 * These tests are about a page that is NOT the dashboard: it renders one
 * `PostJobButton` and knows nothing else, and the context has to do the rest --
 * including fetching the plan and the jobs list the preflight needs, which the
 * dashboard hands over for free.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token', userType: 'employer', isAuthenticated: true }),
}));

const toastSuccess = vi.fn();
vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}));

const getJobs = vi.fn();
const getBilling = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: (...args: unknown[]) => getJobs(...args),
    getBilling: (...args: unknown[]) => getBilling(...args),
}));

// A marker with a publish button: whether the WIZARD opens, and what it reports
// back, is the assertion -- the real one drags in a three-step form.
vi.mock('@/components/employer/PostJobModal', () => ({
    PostJobModal: ({
        open,
        onJobCreated,
    }: {
        open: boolean;
        onJobCreated: (job: unknown) => void;
    }) =>
        open ? (
            <div data-testid="post-job-wizard">
                <button type="button" onClick={() => onJobCreated(postedJob)}>publish</button>
            </div>
        ) : null,
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { PostJobProvider, useJobCreated } from '@/contexts/PostJobContext';
import type { EmployerBilling, Job } from '@/lib/api/employer';

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

const postedJob: Job = { ...activeJob, id: 'job-new', title: 'Framer' };

const freePlan: EmployerBilling = {
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 1,
    activeJobUsage: 1,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

const onCreated = vi.fn();

/** Any employer page that is not the dashboard: one button, no plan state. */
function ApplicantsLikePage() {
    useJobCreated((job) => onCreated(job));
    return <PostJobButton />;
}

/**
 * A page whose listener reads state that changes while the page is open --
 * which the dashboard's does (`handleJobCreated` branches on whether its list
 * has loaded yet, and merges into it). The subscription is registered once, so
 * this is the thing that would go wrong: the provider holding the closure from
 * the render that subscribed and reporting the job into a list that no longer
 * exists.
 */
function PageWithMovingState() {
    const [loaded, setLoaded] = React.useState(false);
    useJobCreated(() => onCreated(loaded));
    return (
        <>
            <PostJobButton />
            <button type="button" onClick={() => setLoaded(true)}>load the list</button>
        </>
    );
}

function renderPage() {
    return renderIntl(
        <PostJobProvider>
            <ApplicantsLikePage />
        </PostJobProvider>,
    );
}

const postJobButton = () =>
    screen.getByRole('button', { name: message('employer_dashboard.jobs.post_job') });

beforeEach(() => {
    vi.clearAllMocks();
    getJobs.mockResolvedValue([activeJob]);
    getBilling.mockResolvedValue({ ...freePlan, activeJobLimit: 3 });
});

describe('post a job from any employer page', () => {
    it('opens the wizard from a page that holds no plan state of its own', async () => {
        renderPage();
        fireEvent.click(postJobButton());

        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        // The preflight needs both, and asks for them together.
        expect(getJobs).toHaveBeenCalledTimes(1);
        expect(getBilling).toHaveBeenCalledTimes(1);
    });

    it('tells every subscriber which job was posted', async () => {
        renderPage();
        fireEvent.click(postJobButton());
        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'publish' }));

        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(postedJob));
        expect(toastSuccess).toHaveBeenCalledWith(message('employer_dashboard.jobs.post_success'));
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
    });

    it('shows the limit dialog instead of the wizard when the plan has no slot', async () => {
        // One active job against a limit of one: the preflight blocks.
        getBilling.mockResolvedValue(freePlan);
        renderPage();
        fireEvent.click(postJobButton());

        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.title'))).toBeInTheDocument());
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
        // Named, so the way out is actionable from a page that never loaded it.
        expect(screen.getByRole('link', { name: activeJob.title })).toBeInTheDocument();
    });

    it('asks again on every open, so a slot freed elsewhere is seen', async () => {
        // The employer's one slot is taken: the first open is blocked.
        getBilling.mockResolvedValue(freePlan);
        renderPage();
        fireEvent.click(postJobButton());
        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.title'))).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: message('billing.limit_dialog.dismiss') }));

        /*
         * They pause that job on the dashboard, or upgrade, and come back. The
         * two numbers this gate turns on are BOTH changed from other pages, and
         * nothing tells this context when that happened -- so a snapshot kept
         * between opens would go on refusing an employer who has just made
         * room (and, the other way round, would wave through one who no longer
         * has any, straight into the 403 the gate exists to pre-empt).
         */
        getJobs.mockResolvedValue([{ ...activeJob, status: 'paused' }]);
        fireEvent.click(postJobButton());

        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        expect(getJobs).toHaveBeenCalledTimes(2);
        expect(getBilling).toHaveBeenCalledTimes(2);
    });

    it('reports into the page as it is NOW, not as it was when it subscribed', async () => {
        renderIntl(
            <PostJobProvider>
                <PageWithMovingState />
            </PostJobProvider>,
        );

        // The list arrives after the subscription was registered.
        fireEvent.click(screen.getByRole('button', { name: 'load the list' }));
        fireEvent.click(postJobButton());
        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'publish' }));

        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(true));
    });

    it('opens without a gate when billing cannot be read at all', async () => {
        getBilling.mockRejectedValue(new Error('billing down'));
        renderPage();
        fireEvent.click(postJobButton());

        // The publish-time 403 stays the backstop; a failed read must never be
        // the thing that stops an employer posting.
        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
    });
});
