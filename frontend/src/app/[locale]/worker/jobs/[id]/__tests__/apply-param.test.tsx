// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { JobDetail } from '@/lib/api/worker';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The onboarding summary's Apply button lands here as
 * `/worker/jobs/{id}?apply=1`: the worker already said which job they want,
 * so the page opens the apply flow for them instead of making them find the
 * button again.
 *
 * It goes through the SAME path as that button (`handleApplyClick`), so the
 * profile-completeness gate still stands in front of the flow. It happens
 * once, on the job's first load, and the param leaves the address bar at
 * once: a reload, a share or a back-and-forward must not reopen it. A job that
 * cannot take an application ignores the param without a word.
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

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
    ProfileCompleteModal: ({ open }: { open: boolean }) => (open ? <div data-testid="profile-gate" /> : null),
}));

// The flow itself is another suite's business: a marker, plus its way back.
vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: ({ onBackToDetails }: { onBackToDetails: () => void }) => (
        <div data-testid="apply-flow">
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
    full_name: 'Alex Rivera',
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

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    apiFetch.mockResolvedValue(profileResponse(COMPLETE_PROFILE));
    visit('');
});

describe('worker job detail — ?apply=1 from the onboarding summary', () => {
    it('opens the apply flow, and takes the param out of the address bar', async () => {
        seed = job();
        visit('?apply=1');

        renderIntl(<WorkerJobDetailPage />);

        expect(await screen.findByTestId('apply-flow')).toBeInTheDocument();
        expect(window.location.search).toBe('');
        expect(window.location.pathname).toBe('/en/worker/jobs/job-1');
        // The same path the Apply button takes: one profile check, then the flow.
        expect(apiFetch).toHaveBeenCalledTimes(1);
        expect(apiFetch.mock.calls[0][0]).toBe('/worker/profile');
    });

    it('still stops at the profile gate when the profile is incomplete', async () => {
        seed = job();
        visit('?apply=1');
        apiFetch.mockResolvedValue(profileResponse({ full_name: 'Alex Rivera' }));

        renderIntl(<WorkerJobDetailPage />);

        expect(await screen.findByTestId('profile-gate')).toBeInTheDocument();
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
    });

    it('does it once: backing out of the flow and a refreshed job do not reopen it', async () => {
        seed = job();
        visit('?apply=1');
        const view = renderIntl(<WorkerJobDetailPage />);
        await screen.findByTestId('apply-flow');

        fireEvent.click(screen.getByRole('button', { name: 'back to details' }));
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        // A refresh hands the page a NEW object for the same job.
        seed = { ...seed };
        view.rerender(<WorkerJobDetailPage />);

        await waitFor(() => expect(screen.getByRole('button', { name: message('worker_job_detail.apply') })).toBeInTheDocument());
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        expect(apiFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the rest of the query when it removes the param', async () => {
        seed = job();
        visit('?ref=wa&apply=1');

        renderIntl(<WorkerJobDetailPage />);

        await screen.findByTestId('apply-flow');
        expect(window.location.search).toBe('?ref=wa');
    });

    it('ignores the param on a job that is no longer open, without a word', async () => {
        seed = job({ status: 'closed' });
        visit('?apply=1');

        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(window.location.search).toBe(''));
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        expect(screen.queryByTestId('profile-gate')).not.toBeInTheDocument();
        expect(apiFetch).not.toHaveBeenCalled();
    });

    it('ignores it on a job the worker already applied to', async () => {
        seed = job({ already_applied: true, application_status: 'pending' });
        visit('?apply=1');

        renderIntl(<WorkerJobDetailPage />);

        await waitFor(() => expect(window.location.search).toBe(''));
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        expect(apiFetch).not.toHaveBeenCalled();
    });

    it('opens nothing without the param', async () => {
        seed = job();

        renderIntl(<WorkerJobDetailPage />);

        expect(await screen.findByRole('button', { name: message('worker_job_detail.apply') })).toBeInTheDocument();
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        expect(apiFetch).not.toHaveBeenCalled();
    });

    it.each(['0', 'true', ''])('treats ?apply=%s as no request at all', async (value) => {
        seed = job();
        visit(`?apply=${value}`);

        renderIntl(<WorkerJobDetailPage />);

        expect(await screen.findByRole('button', { name: message('worker_job_detail.apply') })).toBeInTheDocument();
        expect(screen.queryByTestId('apply-flow')).not.toBeInTheDocument();
        expect(apiFetch).not.toHaveBeenCalled();
    });
});
