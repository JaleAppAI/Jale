// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { Application, ApplicationsPage } from '@/lib/api/worker';

/*
 * The applications list's top-of-page details notice, and the order the rows
 * arrive in.
 *
 * Both halves are the same product ruling: an employer waiting on this worker
 * is the one thing on the page that has to be impossible to miss. Before this
 * lane the page only spoke up when MORE THAN ONE application was waiting -- a
 * single request said nothing at the top and sat wherever `applied_at DESC`
 * happened to put it, which for an old application is below the fold.
 *
 * The mocks are the sibling `hire-row.test.tsx` set: the page's own hooks are
 * replaced so these tests are about the page's wiring, not about
 * `usePageData`.
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
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: vi.fn(),
  acknowledgeHire: vi.fn(),
}));

/**
 * Assigned by each test before rendering; the fake hook seeds itself from it.
 *
 * The page's data is the SERVER'S ANSWER -- rows, cursor and the attention
 * summary together -- because the summary is computed over the worker's whole
 * list and the rows are only a page of it. `pageOf` builds one from rows the
 * way the API does, so a test that cares about neither still reads as a list.
 */
let seed: ApplicationsPage;

function pageOf(applications: Application[]): ApplicationsPage {
  return {
    applications,
    next_cursor: null,
    attention: {
      details_requested: applications
        .filter((a) => a.details_status === 'requested')
        .map((a) => ({
          application_id: a.application_id,
          job_id: a.job_id,
          job_title: a.job_title,
          company_name: a.company_name,
          remaining_count: a.remaining_count ?? 0,
        })),
      unacknowledged_hires: applications.flatMap((a) => (
        a.status === 'hired' && a.hire && !a.hire.acknowledged_at
          ? [{
            application_id: a.application_id,
            job_id: a.job_id,
            job_title: a.job_title,
            company_name: a.company_name,
            hire: a.hire,
          }]
          : []
      )),
    },
  };
}

vi.mock('@/hooks/usePageData', async () => {
  const react = await import('react');
  return {
    usePageData: () => {
      const [data, setState] = react.useState<ApplicationsPage>(() => seed);
      return {
        phase: 'ready' as const,
        data,
        empty: data.applications.length === 0,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: (updater: ApplicationsPage | ((prev: ApplicationsPage) => ApplicationsPage)) =>
          setState((prev) => (typeof updater === 'function' ? updater(prev) : updater)),
      };
    },
  };
});

import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerApplicationsPage from '../page';

function application(overrides: Partial<Application> = {}): Application {
  return {
    application_id: 'aaaaaaaa-1111-4222-8333-444444444444',
    job_id: 'job-1',
    job_title: 'Welder',
    company_name: 'Construcciones Bravo LLC',
    status: 'pending',
    applied_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function requested(overrides: Partial<Application> = {}): Application {
  return application({
    status: 'details_requested',
    details_status: 'requested',
    ...overrides,
  });
}

/**
 * The heading line of the SINGLE top banner, and the one string that tells the
 * two banners apart on this page: the compact row variant drops it, and the
 * multi banner never had it. Everything else -- the body sentence, the CTA's
 * name, its href -- is shared with the row banner, so a `getByText` on any of
 * those finds two elements and throws.
 */
const ONE_HEAD = message('worker_applications.details_banner.one_head');
const MULTI_HEAD = (count: number) => interpolate(
  message('worker_applications.details_banner.many_head'),
  { count },
);
const ROW_BODY = (company: string) => interpolate(
  message('worker_applications.details_banner.row_body'),
  { company },
);

describe('worker applications -- the top-of-page details notice', () => {
  it('speaks up at the top for a SINGLE waiting application', () => {
    seed = pageOf([requested({ company_name: 'Rucoba & Maya', remaining_count: 3 })]);
    renderIntl(<WorkerApplicationsPage />);

    const head = screen.getByText(ONE_HEAD);
    // Above the list, not tucked inside it -- the whole point is that it is
    // visible without scrolling past the rows.
    const [row] = screen.getAllByRole('listitem');
    expect(head.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the row banner as well -- the top notice does not replace it', () => {
    seed = pageOf([requested({ company_name: 'Rucoba & Maya', remaining_count: 3 })]);
    renderIntl(<WorkerApplicationsPage />);

    // Twice: once at the top of the page, once under the row it belongs to.
    expect(screen.getAllByText(ROW_BODY('Rucoba & Maya'))).toHaveLength(2);
    const [row] = screen.getAllByRole('listitem');
    expect(within(row).getByText(ROW_BODY('Rucoba & Maya'))).toBeInTheDocument();
  });

  it('names one employer only once at the top', () => {
    seed = pageOf([requested({ company_name: 'Rucoba & Maya' })]);
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.getAllByText(ONE_HEAD)).toHaveLength(1);
  });

  it('switches to the counted banner when TWO applications are waiting', () => {
    seed = pageOf([
      requested({ company_name: 'Rucoba & Maya' }),
      requested({
        application_id: 'bbbbbbbb-1111-4222-8333-444444444444',
        job_id: 'job-2',
        job_title: 'Concrete Finisher',
        company_name: 'RM Construction',
      }),
    ]);
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.getByText(MULTI_HEAD(2))).toBeInTheDocument();
    // The single-application heading must NOT also be on screen: two top
    // banners saying different things about the same fact is the bug.
    expect(screen.queryByText(ONE_HEAD)).not.toBeInTheDocument();
  });

  it('says nothing at the top when no application is waiting', () => {
    seed = pageOf([application(), application({ application_id: 'cccccccc-1111-4222-8333-444444444444' })]);
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.queryByText(ONE_HEAD)).not.toBeInTheDocument();
    expect(screen.queryByText(MULTI_HEAD(1))).not.toBeInTheDocument();
  });
});

describe('worker applications -- where the waiting rows sit', () => {
  it('floats the waiting row to the top of the list, however old it is', () => {
    // The API order is applied_at DESC, so the requested one comes in LAST.
    seed = pageOf([
      application({ application_id: 'row-new', job_id: 'job-1', job_title: 'Rebar Tier', applied_at: '2026-09-01T00:00:00.000Z' }),
      application({ application_id: 'row-mid', job_id: 'job-2', job_title: 'Drywall Hanger', applied_at: '2026-08-25T00:00:00.000Z' }),
      requested({ application_id: 'row-old', job_id: 'job-3', job_title: 'Roofer', applied_at: '2026-08-10T00:00:00.000Z' }),
    ]);
    renderIntl(<WorkerApplicationsPage />);

    const titles = screen.getAllByRole('listitem').map((row) => within(row).getByText(
      /Rebar Tier|Drywall Hanger|Roofer/,
    ).textContent);
    expect(titles).toEqual(['Roofer', 'Rebar Tier', 'Drywall Hanger']);
  });

  it('leaves the rest of the list in the order the API sent it', () => {
    seed = pageOf([
      application({ application_id: 'row-new', job_id: 'job-1', job_title: 'Rebar Tier', applied_at: '2026-09-01T00:00:00.000Z' }),
      requested({ application_id: 'row-mid', job_id: 'job-2', job_title: 'Drywall Hanger', applied_at: '2026-08-25T00:00:00.000Z' }),
      application({ application_id: 'row-old', job_id: 'job-3', job_title: 'Roofer', applied_at: '2026-08-10T00:00:00.000Z' }),
    ]);
    renderIntl(<WorkerApplicationsPage />);

    const titles = screen.getAllByRole('listitem').map((row) => within(row).getByText(
      /Rebar Tier|Drywall Hanger|Roofer/,
    ).textContent);
    expect(titles).toEqual(['Drywall Hanger', 'Rebar Tier', 'Roofer']);
  });
});
