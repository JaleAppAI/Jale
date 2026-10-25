// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

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

/** Mutable: the restore window and the wrong-role mask are both states here. */
const authState = {
    idToken: 'test-token' as string | null,
    userType: 'employer' as 'employer' | 'worker' | null,
    isAuthenticated: true,
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

const toastSuccess = vi.fn();
vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: toastSuccess, error: vi.fn(), info: vi.fn() }),
}));

/*
 * The post-job tutorial (E2) as a recording handle: which id the provider asks
 * for, the `done` and `walkthrough` it passes on each render, and the `done`
 * the handle held when the provider asked it to run with the wizard (and
 * whether as a replay). `runWithHost` opens the host at once, as the real
 * hook always does, before any guide.
 */
const tutorial = vi.hoisted(() => {
    const latestDone: Record<string, boolean | undefined> = {};
    const walkthrough: Record<string, boolean | undefined> = {};
    const doneAtRun: (boolean | undefined)[] = [];
    const replays: (boolean | undefined)[] = [];
    const ids: string[] = [];
    const handle = {
        maybeAutoOpen: vi.fn(),
        runBeforeHost: vi.fn((openHost: () => void) => openHost()),
        runWithHost: vi.fn((openHost: () => void, _vars?: unknown, options?: { replay?: boolean }) => {
            doneAtRun.push(latestDone.employer_post_job);
            replays.push(options?.replay);
            openHost();
        }),
        replay: vi.fn(),
    };
    return { latestDone, walkthrough, doneAtRun, replays, ids, handle };
});
vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: (id: string, options: { done: boolean | undefined; walkthrough?: boolean }) => {
        tutorial.ids.push(id);
        tutorial.latestDone[id] = options.done;
        tutorial.walkthrough[id] = options.walkthrough;
        return tutorial.handle;
    },
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
import { PostJobProvider, useJobCreated, usePostJob, usePostJobSnapshot } from '@/contexts/PostJobContext';
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
    tutorial.doneAtRun.length = 0;
    tutorial.replays.length = 0;
    tutorial.ids.length = 0;
    for (const id of Object.keys(tutorial.latestDone)) delete tutorial.latestDone[id];
    authState.idToken = 'test-token';
    authState.userType = 'employer';
    authState.isAuthenticated = true;
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
        // The wizard stays open on its own "Job posted" screen, which is the
        // confirmation; a toast on top of it would say the same thing twice.
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument();
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

describe('with no session to post with', () => {
    /*
     * Two ordinary ways to be here: the restore window after a reload, and
     * `AuthContext` masking a session that belongs to the OTHER role. In both,
     * the provider mounts no modal -- so a button that still looked live took
     * a click, did nothing visible, and (before this) armed a wizard that then
     * appeared on its own the moment the token landed.
     */
    it('offers a disabled control rather than a click that does nothing', () => {
        authState.idToken = null;
        authState.isAuthenticated = false;
        renderPage();

        const button = postJobButton();
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-disabled', 'true');

        fireEvent.click(button);
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
        expect(getBilling).not.toHaveBeenCalled();
    });

    it('keeps the wizard shut even if something opens it another way', async () => {
        authState.idToken = null;
        authState.isAuthenticated = false;
        // Captured in an effect, not during render: assigning to an outer
        // variable while rendering is the side effect the lint rule is about,
        // and this file should not model something a component may not do.
        const opener: { current: (() => void) | null } = { current: null };
        function Probe() {
            const { openPostJob } = usePostJob();
            React.useEffect(() => {
                opener.current = openPostJob;
            }, [openPostJob]);
            return null;
        }
        // A fresh element per render: the real `useAuth` is a context, so a
        // session change re-renders the provider. The mock is a plain object,
        // so the change is delivered by rendering the provider again.
        const tree = () => (
            <PostJobProvider>
                <Probe />
                <ApplicantsLikePage />
            </PostJobProvider>
        );
        const { rerender } = renderIntl(tree());

        act(() => opener.current?.());

        /*
         * The assertion is not "nothing happened now" -- with the modal
         * unmounted, nothing visible could have. It is that nothing was ARMED:
         * the SAME provider is now handed a token, mounts the modal, and the
         * wizard must not appear by itself in front of an employer who is not
         * asking for it.
         */
        authState.idToken = 'test-token';
        authState.isAuthenticated = true;
        rerender(tree());

        await waitFor(() => expect(postJobButton()).toBeEnabled());
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
    });

    it('disables the control for a worker session on an employer page', () => {
        // The mask: `AuthContext` reports no session at all while what is in
        // memory belongs to the other role.
        authState.userType = 'worker';
        authState.idToken = null;
        authState.isAuthenticated = false;
        renderPage();

        expect(postJobButton()).toBeDisabled();
    });
});

/*
 * E2: the post-job tutorial is a step-by-step guide that runs INSIDE the
 * wizard: the wizard opens first, and the guide is asked for with it
 * (`runWithHost`), only once the plan gate has let the employer through, and
 * auto-plays only for an employer with no job yet (K1.5). Help's "Guide me
 * through it" asks for it as a replay. Here the hook is a recording handle.
 */
describe('the post-job tutorial', () => {
    const noJobsSnapshot = { billing: { ...freePlan, activeJobLimit: 3, activeJobUsage: 0 }, jobs: [], activeCount: 0 };

    /** A page that already holds the plan and the jobs, as the dashboard does. */
    function PageWithSnapshot({ snapshot }: { snapshot: Parameters<typeof usePostJobSnapshot>[0] }) {
        usePostJobSnapshot(snapshot);
        return <PostJobButton />;
    }

    it('asks for the post-job tutorial and knows nothing about jobs before any read', () => {
        renderPage();

        expect(tutorial.ids).toContain('employer_post_job');
        expect(tutorial.walkthrough.employer_post_job).toBe(true);
        expect(tutorial.latestDone.employer_post_job).toBeUndefined();
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
        expect(tutorial.handle.runBeforeHost).not.toHaveBeenCalled();
    });

    it('runs the guide with the wizard for an employer with no jobs, with done false', async () => {
        getJobs.mockResolvedValue([]);
        renderPage();
        fireEvent.click(postJobButton());

        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        expect(tutorial.handle.runWithHost).toHaveBeenCalledTimes(1);
        expect(tutorial.handle.runBeforeHost).not.toHaveBeenCalled();
        // The read that answered the gate is the one the tutorial saw.
        expect(tutorial.doneAtRun).toEqual([false]);
        expect(tutorial.replays).toEqual([false]);
    });

    it('passes done true once the employer has a job', async () => {
        renderPage();
        fireEvent.click(postJobButton());

        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        expect(tutorial.doneAtRun).toEqual([true]);
    });

    it('takes done from a page that already holds the jobs, with no request', async () => {
        renderIntl(
            <PostJobProvider>
                <PageWithSnapshot snapshot={noJobsSnapshot} />
            </PostJobProvider>,
        );
        expect(tutorial.latestDone.employer_post_job).toBe(false);

        fireEvent.click(postJobButton());

        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        expect(tutorial.doneAtRun).toEqual([false]);
        expect(getJobs).not.toHaveBeenCalled();
    });

    it('never plays on the plan-gate path', async () => {
        getBilling.mockResolvedValue(freePlan);
        renderPage();
        fireEvent.click(postJobButton());

        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.title'))).toBeInTheDocument());
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
    });

    it('asks for the guide as a replay when Help opens the wizard with it, through the same gate', async () => {
        function HelpLikePage() {
            const { openPostJob } = usePostJob();
            return (
                <>
                    <PostJobButton />
                    <button type="button" onClick={() => openPostJob(undefined, { guide: 'replay' })}>
                        guide me
                    </button>
                </>
            );
        }
        renderIntl(
            <PostJobProvider>
                <HelpLikePage />
            </PostJobProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'guide me' }));
        await waitFor(() => expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument());
        expect(tutorial.replays).toEqual([true]);

        // The next plain press is not a replay.
        fireEvent.click(postJobButton());
        await waitFor(() => expect(tutorial.replays).toEqual([true, false]));
    });

    it('never runs the guide when the plan gate refuses a replay', async () => {
        getBilling.mockResolvedValueOnce(freePlan);
        function HelpLikePage() {
            const { openPostJob } = usePostJob();
            return (
                <>
                    <PostJobButton />
                    <button type="button" onClick={() => openPostJob(undefined, { guide: 'replay' })}>
                        guide me
                    </button>
                </>
            );
        }
        renderIntl(
            <PostJobProvider>
                <HelpLikePage />
            </PostJobProvider>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'guide me' }));
        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.title'))).toBeInTheDocument());
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
    });

    it('forgets what a page told it once that page is gone', () => {
        const { rerender } = renderIntl(
            <PostJobProvider>
                <PageWithSnapshot snapshot={noJobsSnapshot} />
            </PostJobProvider>,
        );
        expect(tutorial.latestDone.employer_post_job).toBe(false);

        rerender(
            <PostJobProvider>
                <PostJobButton />
            </PostJobProvider>,
        );

        // Back to unknown: the next press reads the jobs again.
        expect(tutorial.latestDone.employer_post_job).toBeUndefined();
    });

    it('keeps done unknown for a session that is not an employer', () => {
        authState.userType = 'worker';
        renderIntl(
            <PostJobProvider>
                <PageWithSnapshot snapshot={noJobsSnapshot} />
            </PostJobProvider>,
        );

        expect(tutorial.latestDone.employer_post_job).toBeUndefined();
    });
});
