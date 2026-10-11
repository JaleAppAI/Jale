// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The feed's filters belong to the URL.
 *
 * They used to be plain component state: a worker narrowed the list to
 * "part-time roofing", tapped a job to read it, came back — and got the
 * unfiltered feed, because the page had remounted and every filter had gone
 * back to its default. Anything that leaves the page is the same story: the
 * details form, the profile, a shared link opened in another tab.
 *
 * So the query string is what the page is restored FROM, and what every filter
 * change is written TO (with `replace`, so narrowing a search does not build a
 * history entry per keystroke, and with `scroll: false`, so the list does not
 * jump to the top while the worker is reading it).
 */

const searchParams = { current: new URLSearchParams() };
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams.current,
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace }),
  usePathname: () => '/worker/home',
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

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
}));

const getJobs = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getJobs: (...args: unknown[]) => getJobs(...args),
  updateWorkerProfile: vi.fn(),
  getApplications: vi.fn().mockResolvedValue({ applications: [] }),
  acknowledgeHire: vi.fn(),
}));

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerHomePage from '../page';

const searchBox = () => screen.getByRole('searchbox', { name: message('worker_home.search_placeholder') });
const chip = (label: string) => screen.getByRole('button', { name: message(`worker_home.filter.${label}`) });

/** The filters the page asked the server for, most recent last. */
function jobFilters(): Array<Record<string, string>> {
  return getJobs.mock.calls.map(([, filters]) => filters as Record<string, string>);
}

const FEED_ORIGIN_KEY = 'jale.worker.feed-origin';

const job = {
  id: 'job-1',
  title: 'Drywall Finisher',
  location: 'El Paso, TX',
  job_type: 'full-time',
  company_name: 'RM Construction',
  required_docs: [],
  match_reasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
  sessionStorage.clear();
  getJobs.mockResolvedValue({ jobs: [], other_jobs: [] });
});

describe('worker feed filters — restored from the URL', () => {
  it('starts filtered when the URL says so', async () => {
    searchParams.current = new URLSearchParams('q=roofing&type=part-time');

    renderIntl(<WorkerHomePage />);

    // On screen...
    expect(searchBox()).toHaveValue('roofing');
    expect(chip('part_time')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('all')).toHaveAttribute('aria-pressed', 'false');
    // ...and in the very first request, not in a second one 300ms later.
    await waitFor(() => expect(getJobs).toHaveBeenCalled());
    expect(jobFilters()[0]).toEqual({ search: 'roofing', job_type: 'part-time' });
  });

  it('ignores a job type it does not know', async () => {
    // The query string is user-editable, and an unknown value must degrade to
    // "no filter" rather than be forwarded to the API.
    searchParams.current = new URLSearchParams('type=whatever');

    renderIntl(<WorkerHomePage />);

    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(getJobs).toHaveBeenCalled());
    expect(jobFilters()[0]).toEqual({});
  });
});

describe('worker feed filters — written to the URL', () => {
  it('records a typed search, once the typing settles', async () => {
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(getJobs).toHaveBeenCalled());

    fireEvent.change(searchBox(), { target: { value: 'roofing' } });

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/home?q=roofing', { scroll: false }));
  });

  it('records a job type immediately', async () => {
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(getJobs).toHaveBeenCalled());

    fireEvent.click(chip('contract'));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/home?type=contract', { scroll: false }));
  });

  it('drops the parameters again when the filters are cleared', async () => {
    searchParams.current = new URLSearchParams('q=roofing&type=contract');

    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(getJobs).toHaveBeenCalled());

    fireEvent.change(searchBox(), { target: { value: '' } });
    fireEvent.click(chip('all'));

    // The bare path, with no trailing '?' -- an empty query string is not a
    // filter, and leaving one behind would make every shared feed link ugly
    // and every comparison of "is this the same URL" wrong.
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/worker/home', { scroll: false }));
  });

  it('remembers the feed URL for the job page to come back to', async () => {
    searchParams.current = new URLSearchParams('q=roofing');

    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(sessionStorage.getItem('jale.worker.feed-url')).toBe('/worker/home?q=roofing'));
  });
});

/*
 * "I came here from the feed" is a fact about ONE navigation.
 *
 * The job page uses it to go back through history instead of following the
 * link, because that restores the scroll position. A modifier-click opens the
 * job in a NEW tab and leaves this one on the feed, so the marker it wrote
 * here describes a navigation that never happened -- and sessionStorage is
 * copied into that new tab, so both of them would believe it. Only a click
 * that navigates this tab may write it.
 */
describe('worker feed — marking the way back', () => {
  it('marks a plain click, which is the one that leaves the feed', async () => {
    getJobs.mockResolvedValue({ jobs: [job], other_jobs: [] });

    renderIntl(<WorkerHomePage />);
    fireEvent.click(await screen.findByText('Drywall Finisher'));

    expect(sessionStorage.getItem(FEED_ORIGIN_KEY)).not.toBeNull();
  });

  it('leaves a ctrl-click alone: that tab stays on the feed', async () => {
    getJobs.mockResolvedValue({ jobs: [job], other_jobs: [] });

    renderIntl(<WorkerHomePage />);
    fireEvent.click(await screen.findByText('Drywall Finisher'), { ctrlKey: true });

    expect(sessionStorage.getItem(FEED_ORIGIN_KEY)).toBeNull();
  });
});
