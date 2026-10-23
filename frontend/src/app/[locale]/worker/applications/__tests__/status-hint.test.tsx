// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { Application, ApplicationsPage } from '@/lib/api/worker';

/*
 * Every row says, in one short line, what its status means for the worker:
 * "Applied" alone does not say that the next move is the employer's. One hint
 * per status, and the legacy statuses read as the status they normalise to.
 *
 * The mocks are the sibling `details-banner.test.tsx` set.
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

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
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


const STATUSES = [
  ['pending', 'pending'],
  ['contacted', 'contacted'],
  ['talking', 'talking'],
  ['details_requested', 'details_requested'],
  ['hired', 'hired'],
  ['not_interested', 'not_interested'],
  // Legacy values still stored on older rows.
  ['reviewed', 'contacted'],
  ['rejected', 'not_interested'],
] as const;

function rowFor(title: string): HTMLElement {
  return screen.getByText(title).closest('li')!;
}

describe('worker applications — a hint under each status', () => {
  it.each(['en', 'es'] as const)('gives every status its own one-line hint (%s)', (locale) => {
    seed = pageOf(STATUSES.map(([status], index) => application({
      application_id: `aaaaaaaa-1111-4222-8333-44444444444${index}`,
      job_id: `job-${index}`,
      job_title: `Job ${status}`,
      // The cast is for the two legacy values, which older rows still carry.
      status: status as Application['status'],
    })));
    renderIntl(<WorkerApplicationsPage />, locale);

    for (const [status, normalized] of STATUSES) {
      expect(
        within(rowFor(`Job ${status}`)).getByText(message(`worker_applications.status_hint.${normalized}`, locale)),
      ).toBeInTheDocument();
    }
  });

  it('has exactly one hint per status, all different', () => {
    const hints = (['pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested'] as const)
      .map((status) => message(`worker_applications.status_hint.${status}`));
    expect(new Set(hints).size).toBe(6);
  });
});
