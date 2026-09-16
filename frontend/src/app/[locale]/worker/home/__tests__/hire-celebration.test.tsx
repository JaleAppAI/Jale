// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { Application, ApplicationHire } from '@/lib/api/worker';

/*
 * The wiring, not the components: given a `hired` row with a `hire` block, does
 * the worker home show the right ONE of the two states, and does closing or
 * dismissing it write the matching receipt?
 *
 * The three states are decided by two nullable timestamps, which is exactly the
 * shape that gets inverted by accident:
 *   seen_at null, acknowledged_at null -> modal (and the banner behind it)
 *   seen_at set,  acknowledged_at null -> banner only
 *   acknowledged_at set                -> nothing, forever
 *
 * Getting that wrong is not a cosmetic bug: it is either a celebration that
 * re-fires on every visit for the rest of the account's life, or a hire the
 * worker is never told about.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  // The page keeps its filters in the query string; this suite is about the
  // hire celebration, so the navigation is stubbed and never asserted on.
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/worker/home',
}));

/**
 * Mutable, because an id-token ROTATION is a real event on this page: the
 * silent 401 refresh in `apiFetch` hands the context a new token, `idToken` is
 * the applications effect's only dep, and the effect therefore re-runs and
 * refetches. A constant token can never exercise that second run, which is
 * exactly where the dismissed-notice bug lived.
 */
const authToken = { current: 'test-token' };
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: authToken.current }),
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

// The page's own best-effort profile GET. Left unmocked it would reach a real
// `fetch` and make the suite depend on network timing for a call whose result
// this test does not care about.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
}));

const getApplications = vi.fn();
const acknowledgeHire = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getJobs: vi.fn().mockResolvedValue({ jobs: [], other_jobs: [] }),
  updateWorkerProfile: vi.fn(),
  getApplications: (...args: unknown[]) => getApplications(...args),
  acknowledgeHire: (...args: unknown[]) => acknowledgeHire(...args),
}));

type JobFeed = { jobs: unknown[]; otherJobs: unknown[] };

vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({
    phase: 'ready' as const,
    data: { jobs: [], otherJobs: [] } as JobFeed,
    empty: true,
    errorKind: null,
    refreshing: false,
    refreshError: null,
    retry: vi.fn(),
    refresh: vi.fn(),
    setData: vi.fn(),
  }),
}));

import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerHomePage from '../page';

const APPLICATION_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';
const DEFAULT_COMPANY = 'Construcciones Bravo LLC';

function hire(overrides: Partial<ApplicationHire> = {}): ApplicationHire {
  return {
    hired_at: '2026-09-03T18:00:00.000Z',
    seen_at: null,
    acknowledged_at: null,
    start_date: '2026-09-15',
    location: 'Austin, TX',
    shift_schedule: 'Mon-Fri, 7:00-15:30',
    // The LEGACY pay column with no structured columns behind it -- the
    // fallback branch of `formatPay`, and a real shape for a job created
    // before 023/033.
    pay: '$24-$28/hour',
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    // The A1 fields, so this suite exercises the copy path production
    // actually takes. `company` is the employer's real name (the endpoint
    // reports the "Empleador" placeholder as null instead), which is a
    // different field from the row's `company_name` below -- `application()`
    // keeps the two agreeing so a heading assertion reads the same either
    // way, and one test at the bottom drops both fields for the pre-095 wire
    // shape.
    trade: { category: 'electrician', other: null, canonical_en: null, canonical_es: null },
    company: DEFAULT_COMPANY,
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  const companyName = overrides.company_name ?? DEFAULT_COMPANY;
  return {
    application_id: APPLICATION_ID,
    job_id: 'job-1',
    job_title: 'Welder',
    company_name: companyName,
    status: 'hired',
    applied_at: '2026-08-28T00:00:00.000Z',
    // Derived, not a constant: the "chains two unseen hires" test below names
    // a second employer through `company_name` alone, and the celebration
    // reads `hire.company`.
    hire: hire({ company: companyName }),
    ...overrides,
  };
}

/**
 * The trade word as the copy reads it: the real catalogue label with its
 * leading capital folded, the way `hireTradePhrase` folds it.
 */
const TRADE = (() => {
  const label = message('employer_dashboard.modal.trade.electrician');
  return label.slice(0, 1).toLocaleLowerCase('en-US') + label.slice(1);
})();

/**
 * The A1 heading: a trade and a real company name, which is what a hire on
 * this page now looks like. The pre-A1 `banner.title` (job title + company)
 * still exists and is asserted once, at the bottom of the first describe.
 */
const BANNER_TITLE = interpolate(
  message('worker_applications.hired_celebration.banner.title_trade'),
  { trade: TRADE, company: DEFAULT_COMPANY },
);

function seed(applications: Application[]) {
  getApplications.mockResolvedValue({ applications });
}

beforeEach(() => {
  getApplications.mockReset();
  acknowledgeHire.mockReset();
  acknowledgeHire.mockResolvedValue({ seen_at: null, acknowledged_at: null });
  authToken.current = 'test-token';
});

describe('worker home -- the hire celebration', () => {
  it('opens the modal for a hire the worker has not been shown yet', async () => {
    seed([application()]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('heading', {
      name: interpolate(message('worker_applications.hired_celebration.modal.title_trade'), {
        company: DEFAULT_COMPANY, trade: TRADE,
      }),
    })).toBeInTheDocument();
  });

  it('closing it writes the `seen` receipt and leaves the banner standing', async () => {
    seed([application()]);
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));

    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', APPLICATION_ID, 'seen');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The state moves modal -> banner locally, without a refetch: the receipt
    // is fire-and-forget, so nothing on screen may wait on it.
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();
  });

  it('dismissing the banner writes the `dismissed` receipt and removes it', async () => {
    seed([application({ hire: hire({ seen_at: '2026-09-03T18:05:00.000Z' }) })]);
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument());
    // Already seen: no second interruption.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));

    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', APPLICATION_ID, 'dismissed');
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
  });

  it('walks the whole arc in one visit: modal -> banner -> gone', async () => {
    seed([application()]);
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));
    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));

    expect(acknowledgeHire.mock.calls.map((call) => call[2])).toEqual(['seen', 'dismissed']);
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows nothing at all once the hire has been acknowledged', async () => {
    seed([application({
      hire: hire({
        seen_at: '2026-09-03T18:05:00.000Z',
        acknowledged_at: '2026-09-03T18:06:00.000Z',
      }),
    })]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
  });

  it('ignores a row that is not hired, even if a stale `hire` block rides along', async () => {
    // Defence against an employer moving someone back out of `hired`: the
    // status is the authority, not the presence of the block.
    seed([application({ status: 'talking' })]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
  });

  it('ignores a hired row the backend sent without a hire block', async () => {
    // The field is optional on purpose -- this frontend may deploy first.
    seed([application({ hire: undefined })]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
  });

  it('dismisses even when the receipt call fails', async () => {
    // A worker pressing × has made a decision. Blocking it on the network, or
    // rolling it back on a 500, would argue with them about their own screen.
    acknowledgeHire.mockRejectedValue(new Error('offline'));
    seed([application({ hire: hire({ seen_at: '2026-09-03T18:05:00.000Z' }) })]);
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));

    expect(screen.queryByText(BANNER_TITLE)).not.toBeInTheDocument();
    // And the rejection is swallowed rather than surfacing as an error state.
    await waitFor(() => expect(acknowledgeHire).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('puts the hire above a details request -- a job won outranks a form to fill', async () => {
    seed([
      application({
        application_id: 'app-details',
        job_id: 'job-2',
        job_title: 'Finish Carpenter',
        company_name: 'Lone Star Interiors',
        status: 'details_requested',
        details_status: 'requested',
        hire: undefined,
      }),
      application({ hire: hire({ seen_at: '2026-09-03T18:05:00.000Z' }) }),
    ]);
    renderIntl(<WorkerHomePage />);

    const hireBanner = await screen.findByText(BANNER_TITLE);
    const detailsBanner = screen.getByText(
      interpolate(message('worker_applications.details_banner.row_body'), {
        company: 'Lone Star Interiors',
      }),
    );

    expect(hireBanner.compareDocumentPosition(detailsBanner))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('survives the applications call failing -- the job feed is not taken with it', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The page itself still rendered.
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });
  it('chains two unseen hires: closing the first opens a fresh dialog for the second', async () => {
    const SECOND_ID = '11111111-2222-4333-8444-555555555555';
    seed([
      application(),
      application({ application_id: SECOND_ID, job_title: 'Plumber', company_name: 'Aguilar Plumbing' }),
    ]);
    renderIntl(<WorkerHomePage />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    const first = screen.getByRole('dialog');
    expect(first).toHaveTextContent('Construcciones Bravo LLC');

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));

    // A NEW dialog element (keyed by application), not the first one with its
    // text swapped: that is what gives hire #2 its own confetti and focus.
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Aguilar Plumbing'));
    expect(screen.getByRole('dialog')).not.toBe(first);
    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', APPLICATION_ID, 'seen');
    expect(acknowledgeHire).not.toHaveBeenCalledWith('test-token', SECOND_ID, 'seen');

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', SECOND_ID, 'seen');
    expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument();
    expect(screen.getByText(interpolate(
      message('worker_applications.hired_celebration.banner.title_trade'),
      { trade: TRADE, company: 'Aguilar Plumbing' },
    ))).toBeInTheDocument();
  });

  it('still celebrates a pre-095 hire that carries no trade and no company', async () => {
    // The two A1 fields are optional because `hire` shipped (migration 095)
    // before they existed. A frontend deployed ahead of the backend gets this
    // shape, and it has to produce a sentence rather than a raw key path --
    // the legacy heading, off the list row's own `company_name`.
    seed([application({ hire: hire({ trade: undefined, company: undefined }) })]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('heading', {
      name: interpolate(message('worker_applications.hired_celebration.modal.title'), {
        company: DEFAULT_COMPANY,
      }),
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: message('worker_applications.hired_celebration.modal.cta'),
    }));

    expect(screen.getByText(interpolate(
      message('worker_applications.hired_celebration.banner.title'),
      { title: 'Welder', company: DEFAULT_COMPANY },
    ))).toBeInTheDocument();
  });

  it('does not open the modal over a worker who is already typing; the banner still shows', async () => {
    let resolveApplications!: (value: { applications: Application[] }) => void;
    getApplications.mockReturnValue(new Promise((resolve) => { resolveApplications = resolve; }));
    renderIntl(<WorkerHomePage />);

    // The worker reaches a text box before the applications call lands.
    const box = document.createElement('input');
    document.body.appendChild(box);
    box.focus();
    expect(document.activeElement).toBe(box);

    resolveApplications({ applications: [application()] });

    await waitFor(() => expect(screen.getByText(BANNER_TITLE)).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(box);
    // Not "seen": the modal is owed on the next visit.
    expect(acknowledgeHire).not.toHaveBeenCalled();
    box.remove();
  });
});

/**
 * The same failure, from the WORKER's side.
 *
 * This call is best-effort by design -- it must never take the job feed's
 * phase with it -- but "best-effort" was implemented as `.catch(() => {})`,
 * and a swallowed failure here is not a degraded page: it is a page that
 * silently omits the one notice a worker may have opened the app for. An
 * employer asking for details, and a hire, both arrive through this response.
 * A worker who sees a normal-looking home page has no reason to look further.
 *
 * So the failure gets a sentence. Not an error state, not a retry -- the feed
 * below is real and the notice is a footnote, the same shape the filter-refetch
 * failure already uses on this page.
 */
describe('worker home -- a failed applications fetch is visible', () => {
  it('says so when the call fails', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    renderIntl(<WorkerHomePage />);

    expect(await screen.findByText(message('worker_home.applications_error'))).toBeInTheDocument();
  });

  it('says it in Spanish too', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    renderIntl(<WorkerHomePage />, 'es');

    expect(await screen.findByText(message('worker_home.applications_error', 'es')))
      .toBeInTheDocument();
  });

  it('can be dismissed', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    renderIntl(<WorkerHomePage />);
    await screen.findByText(message('worker_home.applications_error'));

    fireEvent.click(screen.getByRole('button', { name: message('common.feedback.dismiss') }));

    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();
  });

  it('stays quiet about a request the page itself aborted', async () => {
    // The effect aborts on unmount and on an id-token rotation. That is this
    // page cancelling its own work, not a failure, and a notice about it would
    // be a lie told to a worker whose applications loaded fine.
    //
    // A real `DOMException`, which is what a fetch abort actually rejects
    // with -- not an `Error` with its `name` reassigned. The two are only
    // interchangeable if the guard happens to accept both, which is the thing
    // under test.
    getApplications.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();
  });

  it('says nothing when the call succeeds', async () => {
    seed([]);
    renderIntl(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();
  });

  /*
   * A dismissal is about a CONFIRMED failure, so the reset that re-arms it has
   * to travel with the next confirmed failure -- not with the next attempt.
   *
   * The two are easy to confuse and the difference is visible: `idToken` is
   * this effect's only dep, `apiFetch`'s silent 401 refresh rotates it, and
   * nothing about that rotation is a worker action. Re-arming on the attempt
   * edge therefore put a notice the worker had already waved away back on
   * screen the instant an unrelated token refresh fired -- while the new
   * request was still in flight, on no evidence at all -- and then flashed it
   * off again a moment later if that request succeeded.
   */
  it('does not resurrect a dismissed notice when the id token rotates', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    const { rerender } = renderIntl(<WorkerHomePage />);
    await screen.findByText(message('worker_home.applications_error'));

    fireEvent.click(screen.getByRole('button', { name: message('common.feedback.dismiss') }));
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();

    // The refresh rotates the token and the effect refetches. Held pending on
    // purpose: this is the window in which the old code re-showed the notice.
    let resolveRetry!: (value: { applications: Application[] }) => void;
    getApplications.mockReturnValue(new Promise((resolve) => { resolveRetry = resolve; }));
    authToken.current = 'rotated-token';
    rerender(<WorkerHomePage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalledTimes(2));
    // The paging options are the scan's own (`{ limit: 100 }`, the server's
    // cap); what this line is about is the ROTATED token being used.
    expect(getApplications).toHaveBeenLastCalledWith('rotated-token', expect.anything(), { limit: 100 });
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();

    // ...and the retry SUCCEEDS. The details banner arriving proves the
    // success path ran, so the absent notice below is a real observation
    // rather than an assertion made before anything happened.
    resolveRetry({ applications: [application({
      application_id: 'app-details',
      job_id: 'job-2',
      job_title: 'Finish Carpenter',
      company_name: 'Lone Star Interiors',
      status: 'details_requested',
      details_status: 'requested',
      hire: undefined,
    })] });

    await waitFor(() => expect(screen.getByText(interpolate(
      message('worker_applications.details_banner.row_body'),
      { company: 'Lone Star Interiors' },
    ))).toBeInTheDocument());
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();
  });

  it('speaks up again when the retry fails too', async () => {
    // The other side of the same rule: re-arming on a confirmed failure must
    // still re-arm. A dismissal is not a standing agreement never to hear
    // about the next one.
    getApplications.mockRejectedValue(new Error('offline'));
    const { rerender } = renderIntl(<WorkerHomePage />);
    await screen.findByText(message('worker_home.applications_error'));

    fireEvent.click(screen.getByRole('button', { name: message('common.feedback.dismiss') }));
    expect(screen.queryByText(message('worker_home.applications_error'))).not.toBeInTheDocument();

    authToken.current = 'rotated-token';
    rerender(<WorkerHomePage />);

    expect(await screen.findByText(message('worker_home.applications_error')))
      .toBeInTheDocument();
  });
});
