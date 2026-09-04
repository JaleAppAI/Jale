// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';

import { ApiError } from '@/lib/api/errors';
import type { EmployerBilling, Job } from '@/lib/api/employer';

/*
 * The reported bug, in one sentence: a free-plan employer with their one slot
 * already taken could open the wizard, fill in all three steps, press Publish,
 * and only THEN be told there was no slot -- at which point the notice's one
 * self-service way out ("Pause a job") navigates here and `handleClose` resets
 * the form, so the draft is gone.
 *
 * The gate has to sit at the button, and there are FIVE buttons: the shell
 * action, the hero CTA, the panel header, the quick-post panel, and the
 * first-run empty card. Four render together on a board with jobs (hence the
 * `toBe(4)` below); the empty card replaces the list, so it gets its own test.
 * A gate on four of five is not a gate.
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
import EmployerDashboardPage from '../page';

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

const dialogTitle = () => message('billing.limit_dialog.title');
/** The "Post Job" controls: the shell action, the panel header, the empty card. */
const postJobButtons = () =>
    screen.getAllByRole('button', { name: message('employer_dashboard.jobs.post_job') });
/**
 * Every control that opens the wizard. Two labels, not one -- the hero and the
 * quick-post panel say "Post a job" while the three above say "Post Job" --
 * and the second group is `getAll`, because those two share their label.
 */
const wizardEntryPoints = () => [
    ...postJobButtons(),
    ...screen.getAllByRole('button', { name: message('employer_dashboard.hero.primary_cta') }),
];

beforeEach(() => {
    vi.clearAllMocks();
    seed = { jobs: [activeJob], billing: freePlan, templateCount: 0 };
});

describe('post-a-job plan gate', () => {
    it('opens the limit dialog instead of the wizard when the slot is taken', () => {
        renderIntl(<EmployerDashboardPage />);
        fireEvent.click(postJobButtons()[0]);

        expect(screen.getByText(dialogTitle())).toBeInTheDocument();
        expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
    });

    it('names the job holding the slot and offers both ways out', () => {
        renderIntl(<EmployerDashboardPage />);
        fireEvent.click(postJobButtons()[0]);

        // Scoped to the dialog: the standing free-plan banner on the page
        // behind it offers its own upgrade link with the same words.
        const dialog = within(screen.getByRole('dialog'));
        /*
         * The owner-supplied sentence, rendered, params and all. `renderIntl`
         * passes `onError={() => {}}` like the app does, so a `bodyKey` that
         * disagrees with the catalogue would print the raw key path into the
         * dialog and every OTHER assertion here would still pass -- this is
         * the only thing standing between that and the release.
         */
        const sentence = [
            // The plan name is a bold noun in front of the sentence, not spliced
            // into it, so the paragraph's own text is the two joined.
            message('billing.plan_name.employer_free'),
            interpolate(message('billing.limit_dialog.body_jobs_preflight'), { limit: 1, used: 1 }),
        ].join(' · ');
        // A function matcher, because the plan name sits in a nested `<strong>`
        // and the default text matcher only sees a node's OWN text children.
        expect(
            dialog.getByText((_text, el) => el?.tagName === 'P' && el.textContent === sentence),
        ).toBeInTheDocument();
        expect(dialog.getByText(message('billing.limit_dialog.blocking_heading'))).toBeInTheDocument();
        expect(dialog.getByRole('link', { name: activeJob.title })).toBeInTheDocument();
        expect(dialog.getByRole('link', { name: message('billing.limit_dialog.cta_pause_job') })).toBeInTheDocument();
        expect(
            dialog.getByRole('link', { name: new RegExp(message('billing.limit_dialog.cta_upgrade')) }),
        ).toBeInTheDocument();
    });

    it('gates every entry point to the wizard', () => {
        renderIntl(<EmployerDashboardPage />);
        const entryPoints = wizardEntryPoints();
        // Shell action + panel header + hero + quick post on a board with jobs.
        expect(entryPoints.length).toBe(4);

        for (const button of entryPoints) {
            fireEvent.click(button);
            expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
            expect(screen.getByText(dialogTitle())).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: message('billing.limit_dialog.dismiss') }));
        }
    });

    it('gates the first-run empty card too', () => {
        // No jobs, and a plan that includes none: the only case where the empty
        // board and a reached limit coexist.
        seed = { jobs: [], billing: { ...freePlan, activeJobLimit: 0, activeJobUsage: 0 }, templateCount: 0 };
        renderIntl(<EmployerDashboardPage />);

        for (const button of postJobButtons()) {
            fireEvent.click(button);
            expect(screen.queryByTestId('post-job-wizard')).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: message('billing.limit_dialog.dismiss') }));
        }
    });

    it('opens the wizard when a slot is free', () => {
        seed = { jobs: [activeJob], billing: { ...freePlan, activeJobLimit: 3 }, templateCount: 0 };
        renderIntl(<EmployerDashboardPage />);
        fireEvent.click(postJobButtons()[0]);

        expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument();
        expect(screen.queryByText(dialogTitle())).not.toBeInTheDocument();
    });

    it('opens the wizard when billing never arrived, leaving the 403 as the backstop', () => {
        seed = { jobs: [activeJob], billing: null, templateCount: null };
        renderIntl(<EmployerDashboardPage />);
        fireEvent.click(postJobButtons()[0]);

        expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument();
    });
});

describe('pause and resume from the board', () => {
    const pauseButtonFor = (title: string) =>
        screen.getByRole('button', {
            name: interpolate(message('employer_dashboard.jobs.status_change.pause_aria'), { title }),
        });
    const pauseButton = () => pauseButtonFor(activeJob.title);
    const resumeButton = () =>
        screen.getByRole('button', {
            name: interpolate(message('employer_dashboard.jobs.status_change.resume_aria'), {
                title: activeJob.title,
            }),
        });

    it('pauses in place and frees the slot for the next post', async () => {
        updateJobStatus.mockResolvedValue({ ...activeJob, status: 'paused' });
        renderIntl(<EmployerDashboardPage />);

        fireEvent.click(pauseButton());
        await waitFor(() =>
            expect(updateJobStatus).toHaveBeenCalledWith('test-token', activeJob.id, 'paused'));
        await waitFor(() => expect(resumeButton()).toBeInTheDocument());
        expect(toastSuccess).toHaveBeenCalledWith(
            message('employer_dashboard.jobs.status_change.pause_success'));

        // The gate must read the LIVE count, not billing's load-time snapshot
        // (`activeJobUsage` is still 1 here) -- otherwise freeing a slot on
        // this very board would not unblock posting.
        fireEvent.click(postJobButtons()[0]);
        expect(screen.getByTestId('post-job-wizard')).toBeInTheDocument();
    });

    it('shows the limit dialog when a resume is refused by the plan', async () => {
        seed = {
            jobs: [{ ...activeJob, status: 'paused' }],
            billing: { ...freePlan, activeJobUsage: 0 },
            templateCount: 0,
        };
        updateJobStatus.mockRejectedValue(
            new ApiError(403, 'job_limit_reached', { active_job_limit: 1, active_jobs: 1, plan_code: 'employer_free' }),
        );
        renderIntl(<EmployerDashboardPage />);

        fireEvent.click(resumeButton());

        await waitFor(() => expect(screen.getByText(dialogTitle())).toBeInTheDocument());
        // NOT the generic "you do not have access" sentence a bare 403 gets.
        expect(toastError).not.toHaveBeenCalled();
    });

    it('sends one request when two rows are clicked in the same tick', async () => {
        /*
         * The guard cannot be the render closure. Two DIFFERENT rows means
         * neither button is disabled at click time, and a closed-over
         * `pendingStatusJobId` is still `null` in both handlers -- so both
         * would PATCH, and whichever settled first would clear the other's
         * pending marker, leaving a live request with no frozen row.
         */
        const second: Job = { ...activeJob, id: 'job-2', title: 'Framer' };
        seed = { jobs: [activeJob, second], billing: { ...freePlan, activeJobLimit: 3 }, templateCount: 0 };
        // Never settles: the second click lands while the first PATCH is open.
        updateJobStatus.mockReturnValue(new Promise(() => {}));
        renderIntl(<EmployerDashboardPage />);

        const first = pauseButtonFor(activeJob.title);
        const other = pauseButtonFor(second.title);

        // One `act`, so both clicks are dispatched before React re-renders.
        await act(async () => {
            first.click();
            other.click();
        });

        expect(updateJobStatus).toHaveBeenCalledTimes(1);
        expect(updateJobStatus).toHaveBeenCalledWith('test-token', activeJob.id, 'paused');
        // And every row is frozen for as long as the request is open.
        expect(first).toBeDisabled();
        expect(other).toBeDisabled();
    });

    it('reports any other failure without touching the board', async () => {
        updateJobStatus.mockRejectedValue(new ApiError(500, 'internal_error', {}));
        renderIntl(<EmployerDashboardPage />);

        fireEvent.click(pauseButton());

        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(dialogTitle())).not.toBeInTheDocument();
        expect(pauseButton()).toBeInTheDocument();
    });
});
