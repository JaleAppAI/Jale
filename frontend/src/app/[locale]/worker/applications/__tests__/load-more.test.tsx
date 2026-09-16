// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { Application } from '@/lib/api/worker';

/*
 * The applications list is PAGED.
 *
 * It used to be a hard `LIMIT 200` on the server with no way to ask for the
 * rest: a worker past that number could not reach their older applications at
 * all, and everyone else paid for two hundred rows on every load. The page now
 * asks for 50 and offers "Load more", which APPENDS -- the rows already read
 * must not be replaced, reordered, or fetched again.
 *
 * Rendered against the REAL `usePageData`, deliberately: what is being tested
 * is the interplay between the first request, the cursor it returns and the
 * next request, which a stubbed hook would have to fake in full.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  // The real `usePageData` is what this suite exercises, and it reads the
  // pathname for the legal wall's return URL.
  usePathname: () => '/worker/applications',
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

const getApplications = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: (...args: unknown[]) => getApplications(...args),
  acknowledgeHire: vi.fn(),
}));

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerApplicationsPage from '../page';

function application(n: number): Application {
  return {
    application_id: `app-${n}`,
    job_id: `job-${n}`,
    job_title: `Job ${n}`,
    company_name: 'RM Construction',
    status: 'pending',
    applied_at: '2026-09-01T10:00:00.000Z',
    job_status: 'active',
    details_status: 'not_requested',
    remaining_count: 0,
  } as unknown as Application;
}

const loadMoreButton = () => screen.queryByRole('button', { name: message('worker_applications.load_more') });

/** The paging options each call was made with. */
function pagingCalls(): Array<Record<string, unknown> | undefined> {
  return getApplications.mock.calls.map(([, , options]) => options as Record<string, unknown> | undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('worker applications — load more', () => {
  it('appends the next page and then stops offering one', async () => {
    getApplications
      .mockResolvedValueOnce({ applications: [application(1), application(2)], next_cursor: 'cursor-1' })
      .mockResolvedValueOnce({ applications: [application(3)], next_cursor: null });

    renderIntl(<WorkerApplicationsPage />);

    await waitFor(() => expect(screen.getByText('Job 1')).toBeInTheDocument());
    // A first page that is not the whole list says so.
    expect(loadMoreButton()).toBeInTheDocument();

    fireEvent.click(loadMoreButton()!);

    await waitFor(() => expect(screen.getByText('Job 3')).toBeInTheDocument());
    // APPENDED: the rows the worker had already scrolled past are still there.
    expect(screen.getByText('Job 1')).toBeInTheDocument();
    expect(screen.getByText('Job 2')).toBeInTheDocument();
    // ...and the end of the list is the end of the button.
    await waitFor(() => expect(loadMoreButton()).not.toBeInTheDocument());

    // The second request continued from the first one's cursor rather than
    // asking for page 1 again.
    expect(pagingCalls()[1]).toEqual({ limit: 50, cursor: 'cursor-1' });
  });

  it('offers nothing to load when the first page is the whole list', async () => {
    getApplications.mockResolvedValue({ applications: [application(1)], next_cursor: null });

    renderIntl(<WorkerApplicationsPage />);

    await waitFor(() => expect(screen.getByText('Job 1')).toBeInTheDocument());
    expect(loadMoreButton()).not.toBeInTheDocument();
    expect(pagingCalls()[0]).toEqual({ limit: 50 });
  });

  it('keeps the list and the button when a page fails to load', async () => {
    getApplications
      .mockResolvedValueOnce({ applications: [application(1)], next_cursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('network'));

    renderIntl(<WorkerApplicationsPage />);
    await waitFor(() => expect(screen.getByText('Job 1')).toBeInTheDocument());

    fireEvent.click(loadMoreButton()!);

    // A failed NEXT page is a footnote, never a page state: the rows already
    // on screen are real and stay, and the button is still there to retry.
    // Classified copy, never `err.message`: `useErrorMessage` is what keeps a
    // backend code or an exception text off the screen.
    await waitFor(() => expect(screen.getByText(message('common.errors.unknown'))).toBeInTheDocument());
    expect(screen.getByText('Job 1')).toBeInTheDocument();
    expect(loadMoreButton()).toBeInTheDocument();
  });
});
