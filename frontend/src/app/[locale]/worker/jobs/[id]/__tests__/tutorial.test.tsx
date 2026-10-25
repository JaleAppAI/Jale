// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import type { Application, ApplicationsPage, JobDetail } from '@/lib/api/worker';
import type { TutorialHandle, UseTutorialOptions } from '@/lib/tutorials/types';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * W2, the applying guide: how the job page asks for it.
 *
 * Its K1.5 "has done the task" signal is "the worker has any application",
 * which this page does not otherwise load -- so it reads ONE application of
 * its own. Until that read answers, `done` is `undefined` (still loading),
 * and if it fails it stays `undefined`. The page asks for the step-by-step
 * guide (`walkthrough`), and asks for it INSIDE the apply screen, as that
 * screen opens (`runWithHost`): from Apply, from the profile gate's save, and
 * from an `?apply=1` arrival. Nothing opens over the job page itself any
 * more. Whether the guide plays is the hook's decision, so the hook is
 * replaced here by a recorder.
 *
 * The harness is the sibling `apply-param.test.tsx` one.
 */

const { apiFetch, getApplications, tutorial } = vi.hoisted(() => {
    const handle = {
        maybeAutoOpen: vi.fn(),
        runBeforeHost: vi.fn((openHost: () => void) => openHost()),
        runWithHost: vi.fn((openHost: () => void) => openHost()),
        replay: vi.fn(),
    };
    return {
        apiFetch: vi.fn(),
        getApplications: vi.fn(),
        tutorial: {
            handle,
            useTutorial: vi.fn((id: string, options: UseTutorialOptions): TutorialHandle => {
                void id;
                void options;
                return handle;
            }),
        },
    };
});

vi.mock('@/lib/tutorials/use-tutorial', () => ({ useTutorial: tutorial.useTutorial }));

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ back: vi.fn() }),
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
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/PayReferenceHint', () => ({
    PayReferenceHint: () => null,
}));

vi.mock('@/components/worker/ShareJobPanel', () => ({
    ShareJobPanel: () => null,
}));

// The gate, visible only while it is open.
vi.mock('@/components/worker/ProfileCompleteModal', () => ({
    ProfileCompleteModal: ({ open, onSubmit }: { open: boolean; onSubmit: (values: unknown) => Promise<void> }) => (open ? (
        <div data-testid="profile-gate">
            <button type="button" onClick={() => void onSubmit({ full_name: 'Test Worker', skills: ['framing'], availability: 'full_time', location: 'San Antonio, TX' })}>
                save and apply
            </button>
        </div>
    ) : null),
}));

// The flow itself is another suite's business: a marker, plus its way back.
vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: ({ onBackToDetails, cameFromGate }: { onBackToDetails: () => void; cameFromGate?: boolean }) => (
        <div data-testid="apply-flow" data-from-gate={cameFromGate ? '' : undefined}>
            <button type="button" onClick={onBackToDetails}>back to details</button>
        </div>
    ),
}));

// The profile check is a page-local `apiFetch('/worker/profile')`.
vi.mock('@/lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api')>()),
    apiFetch,
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: vi.fn(),
    updateWorkerProfile: vi.fn(),
    getVaultDocuments: vi.fn(async () => ({ documents: [] })),
    recordJobView: vi.fn(),
    getApplications: (...args: unknown[]) => getApplications(...args),
}));

/** Assigned by each test before rendering; the fake hook serves it. */
let seed: JobDetail;

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import WorkerJobDetailPage from '../page';

const COMPLETE_PROFILE = {
    full_name: 'Test Worker',
    skills: ['framing'],
    availability: 'full_time',
    location: 'San Antonio, TX',
};

function profileResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
}

function job(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Concrete Finisher',
        location: 'San Antonio, TX',
        job_type: 'full-time',
        company_name: 'NB Construction',
        required_docs: [],
        missing_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: null,
        status: 'active',
        already_applied: false,
        application_status: null,
        ...over,
    } as JobDetail;
}

/** Puts the browser on this job page with `search` in the address bar. */
function visit(search: string) {
    window.history.replaceState(null, '', `/en/worker/jobs/job-1${search}`);
}


function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function pageOf(applications: Partial<Application>[]): ApplicationsPage {
    return {
        applications: applications as Application[],
        next_cursor: null,
        attention: { details_requested: [], unacknowledged_hires: [] },
    };
}

/** Every `done` the page handed the hook, in render order, de-duplicated in a row. */
function doneSequence(): Array<boolean | undefined> {
    const seen: Array<boolean | undefined> = [];
    for (const [, options] of tutorial.useTutorial.mock.calls) {
        if (seen.length === 0 || seen[seen.length - 1] !== options.done) seen.push(options.done);
    }
    return seen;
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    apiFetch.mockResolvedValue(profileResponse(COMPLETE_PROFILE));
    visit('');
});

describe('worker job page — the W2 guide', () => {
    it('asks for worker_apply as a step-by-step guide, done undefined until the read answers', async () => {
        const read = deferred<ApplicationsPage>();
        getApplications.mockReturnValue(read.promise);
        seed = job();

        renderIntl(<WorkerJobDetailPage />);

        expect(tutorial.useTutorial.mock.calls.every(([id]) => id === 'worker_apply')).toBe(true);
        expect(tutorial.useTutorial.mock.calls.every(([, options]) => options.walkthrough === true)).toBe(true);
        expect(doneSequence()).toEqual([undefined]);

        await act(async () => { read.resolve(pageOf([])); });
        expect(doneSequence()).toEqual([undefined, false]);
    });

    it('reads a single application, no more', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        seed = job();
        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(getApplications).toHaveBeenCalled());
        expect(getApplications).toHaveBeenCalledTimes(1);
        expect(getApplications.mock.calls[0][0]).toBe('test-token');
        expect(getApplications.mock.calls[0][2]).toEqual({ limit: 1 });
    });

    it('passes done once the worker has any application', async () => {
        getApplications.mockResolvedValue(pageOf([{ application_id: 'app-1', status: 'pending' }]));
        seed = job();
        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(doneSequence()).toEqual([undefined, true]));
    });

    it('opens nothing over the job page itself', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        seed = job();
        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(doneSequence()).toEqual([undefined, false]));
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
    });

    it('asks for the guide inside the apply screen as Apply opens it', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        seed = job();
        renderIntl(<WorkerJobDetailPage />);

        fireEvent.click(screen.getByRole('button', { name: message('worker_job_detail.apply') }));
        expect(await screen.findByTestId('apply-flow')).not.toHaveAttribute('data-from-gate');
        expect(tutorial.handle.runWithHost).toHaveBeenCalledTimes(1);
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('asks for it after the profile gate, and marks the screen as opened by the gate', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        apiFetch.mockResolvedValue(profileResponse({ full_name: 'Test Worker', skills: [], availability: null, location: null }));
        seed = job();
        renderIntl(<WorkerJobDetailPage />);

        fireEvent.click(screen.getByRole('button', { name: message('worker_job_detail.apply') }));
        fireEvent.click(await screen.findByRole('button', { name: 'save and apply' }));
        expect(await screen.findByTestId('apply-flow')).toHaveAttribute('data-from-gate');
        expect(tutorial.handle.runWithHost).toHaveBeenCalledTimes(1);
    });

    it('asks for it on an ?apply=1 arrival, inside the flow the arrival opens', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        seed = job();
        visit('?apply=1');

        renderIntl(<WorkerJobDetailPage />);

        expect(await screen.findByTestId('apply-flow')).toBeInTheDocument();
        expect(tutorial.handle.runWithHost).toHaveBeenCalledTimes(1);
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('never asks on a job that can no longer take an application', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        seed = job({ status: 'closed' });
        visit('?apply=1');
        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(doneSequence()).toEqual([undefined, false]));
        expect(screen.queryByTestId('apply-flow')).toBeNull();
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
    });

    it('never asks once the worker has applied: there is no Apply button to start from', async () => {
        getApplications.mockResolvedValue(pageOf([{ application_id: 'app-1', status: 'pending' }]));
        seed = job({ already_applied: true, application_status: 'pending' });
        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(doneSequence()).toEqual([undefined, true]));
        expect(screen.queryByRole('button', { name: message('worker_job_detail.apply') })).toBeNull();
        expect(tutorial.handle.runWithHost).not.toHaveBeenCalled();
    });
});
