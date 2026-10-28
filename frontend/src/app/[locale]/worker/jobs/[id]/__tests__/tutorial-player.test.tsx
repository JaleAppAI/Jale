// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { Application, ApplicationsPage, JobDetail } from '@/lib/api/worker';
import { resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import {
    dialogCount,
    preparePlayer,
    recordsPosted,
    settle,
    workerProviders,
} from '@/components/tutorials/content/__tests__/worker-player';

/*
 * W2 with the real tutorial: the providers as the app layout mounts them and
 * the real player and content. The slides ("How applying works") no longer
 * open over the job page: the step-by-step guide plays inside the apply
 * screen instead (`apply-guide.test.tsx`), and the slides stay in Help. So
 * nothing opens here, on any arrival, and never on top of the profile gate.
 */

const { getApplications, profile } = vi.hoisted(() => ({
    getApplications: vi.fn(),
    profile: { current: {} as Record<string, unknown> },
}));

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ back: vi.fn() }),
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
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => null }));
vi.mock('@/components/worker/ShareJobPanel', () => ({ ShareJobPanel: () => null }));
// The flow itself is another suite's business: a marker, plus its way back.
vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: ({ onBackToDetails }: { onBackToDetails: () => void }) => (
        <div data-testid="apply-flow">
            <button type="button" onClick={onBackToDetails}>back to details</button>
        </div>
    ),
}));
// The profile check behind Apply, and the tutorial records, are both `apiFetch`.
vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (path: string, init?: RequestInit, token?: string) =>
            path === '/worker/profile'
                ? Promise.resolve(harness.jsonResponse(200, profile.current))
                : harness.apiFetch(path, init, token),
    };
});
vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: vi.fn(),
    updateWorkerProfile: vi.fn(),
    getVaultDocuments: vi.fn(async () => ({ documents: [] })),
    recordJobView: vi.fn(),
    getApplications: (...args: unknown[]) => getApplications(...args),
}));

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

function pageOf(applications: Partial<Application>[]): ApplicationsPage {
    return {
        applications: applications as Application[],
        next_cursor: null,
        attention: { details_requested: [], unacknowledged_hires: [] },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

function visit(search: string) {
    window.history.replaceState(null, '', `/en/worker/jobs/job-1${search}`);
}

const tutorialDialog = () => screen.queryByRole('dialog', { name: 'How applying works' });

let restorePlayer: () => void;
beforeAll(async () => {
    restorePlayer = await preparePlayer();
});
afterAll(() => restorePlayer());

beforeEach(() => {
    vi.clearAllMocks();
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/worker/jobs/job-1';
    signIn('worker');
    serveTutorials([]);
    profile.current = COMPLETE_PROFILE;
    seed = job();
    visit('');
});

describe('worker job page with the real W2 tutorial', () => {
    it('opens nothing over the job page for a worker with no application: the guide waits for the apply screen', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        const watch = watchDialogs();
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();
        await settle();
        watch.stop();

        expect(tutorialDialog()).toBeNull();
        expect(watch.most()).toBe(0);
        expect(recordsPosted()).toEqual([]);
    });

    it('opens nothing over the Spanish job page either', async () => {
        getApplications.mockResolvedValue(pageOf([]));
        render(<WorkerJobDetailPage />, { wrapper: workerProviders('es') });
        await settle();
        await settle();

        expect(screen.queryByRole('dialog', { name: 'Cómo postularte' })).toBeNull();
        expect(dialogCount()).toBe(0);
    });

    it('does not open for a worker who has applied before', async () => {
        getApplications.mockResolvedValue(pageOf([{ application_id: 'app-1', status: 'pending' }]));
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();

        expect(dialogCount()).toBe(0);
    });

    it('never opens after an ?apply=1 arrival, even once the worker is back on the details', async () => {
        const read = deferred<ApplicationsPage>();
        getApplications.mockReturnValue(read.promise);
        visit('?apply=1');
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });

        fireEvent.click(await screen.findByRole('button', { name: 'back to details' }));
        expect(await screen.findByRole('button', { name: 'Apply' })).toBeInTheDocument();
        await act(async () => { read.resolve(pageOf([])); });
        await settle();

        expect(tutorialDialog()).toBeNull();
        expect(dialogCount()).toBe(0);
        expect(recordsPosted()).toEqual([]);
    });

    it('never opens on top of the profile gate', async () => {
        profile.current = { full_name: 'Test Worker' };
        const read = deferred<ApplicationsPage>();
        getApplications.mockReturnValue(read.promise);
        const watch = watchDialogs();
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();

        // The worker taps Apply before their applications have been read, and
        // an incomplete profile opens the gate.
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(tutorialDialog()).toBeNull();

        await act(async () => { read.resolve(pageOf([])); });
        await settle();
        watch.stop();

        expect(tutorialDialog()).toBeNull();
        expect(dialogCount()).toBe(1);
        expect(watch.most()).toBe(1);
    });
});
