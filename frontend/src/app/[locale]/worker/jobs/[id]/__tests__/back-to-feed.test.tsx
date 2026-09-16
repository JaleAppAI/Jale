// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import type { JobDetail } from '@/lib/api/worker';
import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * "Back to jobs" must land on the feed the worker was actually reading.
 *
 * The feed's filters live in its query string, so a back link hard-wired to
 * `/worker/home` threw them away -- the worker narrowed the list, opened one
 * job, came back, and had to narrow it again. Two ways back, deliberately:
 *
 *   - opened FROM the feed: `router.back()`, which also restores the scroll
 *     position, so a worker who was ten rows down does not land at the top;
 *   - any other arrival (a shared link, a bookmark, a reload, the applications
 *     list): the LINK, carrying the remembered feed URL, which is correct from
 *     anywhere and is all a fresh history can offer.
 */

const back = vi.fn();

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ back }),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        idToken: 'test-token',
        isAuthenticated: true,
        isLoading: false,
        handleLegalWall: (err: unknown) => { throw err; },
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

vi.mock('@/components/worker/ProfileCompleteModal', () => ({
    ProfileCompleteModal: () => null,
}));

vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: () => null,
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: vi.fn(),
    updateWorkerProfile: vi.fn(),
    getVaultDocuments: vi.fn(async () => []),
}));

const job: JobDetail = {
    id: 'job-1',
    title: 'Drywall Finisher',
    location: 'Austin, TX',
    job_type: 'full-time',
    company_name: 'RM Construction',
    pay_min: 22,
    pay_max: 26,
    pay_interval: 'hourly',
    number_of_workers_needed: 1,
    open_count: 1,
    required_docs: [],
    missing_docs: [],
    certification_requirements: [],
    created_at: '2026-06-01T15:00:00.000Z',
    status: 'active',
    already_applied: false,
    application_status: null,
} as unknown as JobDetail;

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: job,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import WorkerJobDetailPage from '../page';

const backLink = () => screen.getByRole('link', { name: message('worker_job_detail.back') });

/**
 * How many entries this tab's history holds. Stubbed rather than pushed:
 * jsdom's history is shared by every test in the file and only ever grows, so
 * a `pushState` in one test would silently decide the next one's answer.
 */
function historyEntries(count: number) {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(count);
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    sessionStorage.clear();
});

describe('worker job detail — back to the feed', () => {
    it('points at the feed the worker left, filters and all', () => {
        sessionStorage.setItem('jale.worker.feed-url', '/worker/home?q=drywall&type=contract');

        renderIntl(<WorkerJobDetailPage />);

        expect(backLink()).toHaveAttribute('href', '/worker/home?q=drywall&type=contract');
    });

    it('falls back to the plain feed when there is nothing remembered', () => {
        renderIntl(<WorkerJobDetailPage />);

        expect(backLink()).toHaveAttribute('href', '/worker/home');
    });

    it('goes back through history when the job was opened from the feed', () => {
        sessionStorage.setItem('jale.worker.feed-url', '/worker/home?q=drywall');
        sessionStorage.setItem('jale.worker.feed-origin', '1');
        // The arrival itself: a tab that navigated here has an entry to go
        // back TO, which is the other half of the condition.
        historyEntries(2);

        renderIntl(<WorkerJobDetailPage />);
        fireEvent.click(backLink());

        expect(back).toHaveBeenCalledTimes(1);
        // The marker is spent: a reload of this page is no longer a
        // navigation away from the feed, and must follow the link instead.
        expect(sessionStorage.getItem('jale.worker.feed-origin')).toBeNull();
    });

    it('follows the link when the job was reached some other way', () => {
        sessionStorage.setItem('jale.worker.feed-url', '/worker/home?q=drywall');

        renderIntl(<WorkerJobDetailPage />);
        fireEvent.click(backLink());

        // No history entry to go back to -- a shared link opened in a fresh
        // tab would land on whatever the browser had before, or nowhere.
        expect(back).not.toHaveBeenCalled();
    });

    it('follows the link in a tab with nothing to go back to', () => {
        // A ctrl-clicked tab INHERITS this tab's sessionStorage, marker and
        // all, while its history holds one entry: `back()` there does nothing
        // at all, which would make "Back to jobs" a dead link.
        sessionStorage.setItem('jale.worker.feed-url', '/worker/home?q=drywall');
        sessionStorage.setItem('jale.worker.feed-origin', '1');
        historyEntries(1);

        renderIntl(<WorkerJobDetailPage />);
        fireEvent.click(backLink());

        expect(back).not.toHaveBeenCalled();
    });

    it('leaves a ctrl-click alone', () => {
        sessionStorage.setItem('jale.worker.feed-origin', '1');
        historyEntries(2);

        renderIntl(<WorkerJobDetailPage />);
        fireEvent.click(backLink(), { ctrlKey: true });

        // "Open the feed in a new tab", not "navigate this one".
        expect(back).not.toHaveBeenCalled();
    });
});
