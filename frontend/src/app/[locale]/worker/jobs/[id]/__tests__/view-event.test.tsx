// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobDetail } from '@/lib/api/worker';
import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

const { apiFetch, recordJobView } = vi.hoisted(() => ({ apiFetch: vi.fn(), recordJobView: vi.fn() }));

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
    recordJobView: (...args: unknown[]) => recordJobView(...args),
    // The page reads one application for the W2 tutorial's "has applied"
    // signal; stubbed so the real fetch never runs here.
    getApplications: vi.fn(async () => ({
        applications: [],
        next_cursor: null,
        attention: { details_requested: [], unacknowledged_hires: [] },
    })),
}));

let pageState: { phase: 'ready' | 'error'; data: JobDetail | null; errorKind: string | null } = { phase: 'ready', data: null, errorKind: null };
vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({
    ...pageState,
    refreshing: false, refreshError: null, retry: vi.fn(), refresh: vi.fn(), setData: vi.fn(),
  }),
}));

import WorkerJobDetailPage from '../page';

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

describe('worker job detail — one view event per visit (K3.6 #17, T-d)', () => {
  beforeEach(() => {
    recordJobView.mockReset();
    sessionStorage.clear();
    visit('');
  });

  it('records one view once the job has loaded, and none on a refetch', () => {
    pageState = { phase: 'ready', data: job(), errorKind: null };
    const view = renderIntl(<WorkerJobDetailPage />);

    expect(recordJobView).toHaveBeenCalledTimes(1);
    expect(recordJobView).toHaveBeenCalledWith('test-token', 'job-1', 'direct');

    // A poll or refresh hands the page a NEW object for the same job.
    pageState = { phase: 'ready', data: job({ description: 'updated' }), errorKind: null };
    view.rerender(<WorkerJobDetailPage />);
    expect(recordJobView).toHaveBeenCalledTimes(1);
  });

  it('records once under StrictMode\'s double effects', () => {
    pageState = { phase: 'ready', data: job(), errorKind: null };
    renderIntl(<StrictMode><WorkerJobDetailPage /></StrictMode>);
    expect(recordJobView).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a job that did not load', () => {
    pageState = { phase: 'error', data: null, errorKind: 'not_found' };
    renderIntl(<WorkerJobDetailPage />);
    expect(recordJobView).not.toHaveBeenCalled();
  });

  it('says "feed" when the worker came from the feed', () => {
    sessionStorage.setItem('jale.worker.feed-origin', String(Date.now()));
    pageState = { phase: 'ready', data: job(), errorKind: null };
    renderIntl(<WorkerJobDetailPage />);
    expect(recordJobView).toHaveBeenCalledWith('test-token', 'job-1', 'feed');
  });

  it('says "public_link" when the worker came through this job\'s public page', () => {
    sessionStorage.setItem('pendingReferral', JSON.stringify({ jobId: 'job-1', shareCode: null }));
    pageState = { phase: 'ready', data: job(), errorKind: null };
    renderIntl(<WorkerJobDetailPage />);
    expect(recordJobView).toHaveBeenCalledWith('test-token', 'job-1', 'public_link');
  });
});
