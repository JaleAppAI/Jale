// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import type { Application, ApplicationHire } from '@/lib/api/worker';

/*
 * The applications list's half of the celebration: the compact banner under a
 * hired row, and the hire's own facts on the row itself.
 *
 * The dismissal here goes through `usePageData`'s `setData` rather than page
 * state, so the mock below is STATEFUL on purpose -- a mock that ignored
 * `setData` would let a page that never calls it pass, which is precisely the
 * bug (an × that fires the receipt and leaves the banner on screen).
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

const acknowledgeHire = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: vi.fn(),
  acknowledgeHire: (...args: unknown[]) => acknowledgeHire(...args),
}));

/** Assigned by each test before rendering; the fake hook seeds itself from it. */
let seed: Application[];

vi.mock('@/hooks/usePageData', async () => {
  const react = await import('react');
  return {
    usePageData: () => {
      const [data, setState] = react.useState<Application[]>(() => seed);
      return {
        phase: 'ready' as const,
        data,
        empty: data.length === 0,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: (updater: Application[] | ((prev: Application[]) => Application[])) =>
          setState((prev) => (typeof updater === 'function' ? updater(prev) : updater)),
      };
    },
  };
});

import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerApplicationsPage from '../page';

const APPLICATION_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';

function hire(overrides: Partial<ApplicationHire> = {}): ApplicationHire {
  return {
    hired_at: '2026-09-03T18:00:00.000Z',
    seen_at: '2026-09-03T18:05:00.000Z',
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
    // The A1 fields, so this suite runs the copy path production takes. The
    // compact banner states neither of them -- that is the point of the
    // assertions below -- but a component that started rendering a heading or
    // a job-title line here would now be caught.
    trade: { category: 'electrician', other: null, canonical_en: null, canonical_es: null },
    company: 'Construcciones Bravo LLC',
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    application_id: APPLICATION_ID,
    job_id: 'job-1',
    job_title: 'Welder',
    company_name: 'Construcciones Bravo LLC',
    status: 'hired',
    applied_at: '2026-08-28T00:00:00.000Z',
    hire: hire(),
    ...overrides,
  };
}

const ROW_BODY = message('worker_applications.hired_celebration.row.body');

beforeEach(() => {
  acknowledgeHire.mockReset();
  acknowledgeHire.mockResolvedValue({ seen_at: null, acknowledged_at: null });
});

describe('worker applications -- the hired row', () => {
  it('puts the compact banner under an unacknowledged hire', () => {
    seed = [application()];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.getByText(ROW_BODY)).toBeInTheDocument();
    // Compact: the row above already names the job and the company, so the
    // banner states NO heading of any A1 variant...
    expect(screen.queryByText(/You're hired|Te contrataron/)).not.toBeInTheDocument();
    // ...and no bare job-title line either. `Welder` appears exactly once on
    // this screen: the row's own title.
    expect(screen.getAllByText('Welder')).toHaveLength(1);
  });

  it('leaves the compact banner alone for a pre-095 hire with no trade or company', () => {
    // The A1 fields are optional (`hire` shipped in migration 095 before they
    // existed). The row copy never used either, so this shape must render the
    // same banner -- and still no heading.
    seed = [application({ hire: hire({ trade: undefined, company: undefined }) })];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.getByText(ROW_BODY)).toBeInTheDocument();
    expect(screen.queryByText(/You're hired|Te contrataron/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Welder')).toHaveLength(1);
  });

  it('shows the hire facts the employer filled in', () => {
    seed = [application()];
    renderIntl(<WorkerApplicationsPage />);

    // Date-only value, UTC-pinned: 2026-09-15 is a Tuesday everywhere.
    expect(screen.getByText(/Tue, Sep 15/)).toBeInTheDocument();
    expect(screen.getByText('Austin, TX')).toBeInTheDocument();
    expect(screen.getByText('$24-$28/hour')).toBeInTheDocument();
  });

  it('leaves out the facts the hire does not carry', () => {
    seed = [application({ hire: hire({ start_date: null, location: null, pay: null }) })];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.queryByText(/Tue, Sep 15/)).not.toBeInTheDocument();
    expect(screen.queryByText('Austin, TX')).not.toBeInTheDocument();
    // The banner still explains what happens next.
    expect(screen.getByText(ROW_BODY)).toBeInTheDocument();
  });

  it('keeps the Hired chip exactly as it was', () => {
    seed = [application()];
    renderIntl(<WorkerApplicationsPage />);

    // Scoped to the row: `stats.hired` renders the same word in the metric
    // card above, so an unscoped query cannot tell the chip from the counter.
    const [row] = screen.getAllByRole('listitem');
    expect(within(row).getByText(message('worker_applications.status_short.hired')))
      .toBeInTheDocument();
  });

  it('dismissing writes the receipt and drops the banner from the row', () => {
    seed = [application()];
    renderIntl(<WorkerApplicationsPage />);

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));

    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', APPLICATION_ID, 'dismissed');
    expect(screen.queryByText(ROW_BODY)).not.toBeInTheDocument();
    // The row itself survives -- only the banner was dismissed.
    expect(screen.getByText('Welder')).toBeInTheDocument();
  });

  it('dismisses even when the receipt call fails', () => {
    acknowledgeHire.mockRejectedValue(new Error('offline'));
    seed = [application()];
    renderIntl(<WorkerApplicationsPage />);

    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));

    expect(screen.queryByText(ROW_BODY)).not.toBeInTheDocument();
  });

  it('shows no banner on a hire that was already acknowledged', () => {
    seed = [application({ hire: hire({ acknowledged_at: '2026-09-03T18:06:00.000Z' }) })];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.queryByText(ROW_BODY)).not.toBeInTheDocument();
    // The facts stay: they are still true, and the worker may want the date.
    expect(screen.getByText(/Tue, Sep 15/)).toBeInTheDocument();
  });

  it('shows no banner on a row that is not hired', () => {
    seed = [application({ status: 'talking', hire: undefined })];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.queryByText(ROW_BODY)).not.toBeInTheDocument();
  });

  it('never opens the celebration modal here -- that belongs to the home page', () => {
    // A worker who lands on the list first must not be interrupted by a dialog
    // on a screen they navigated to deliberately.
    seed = [application({ hire: hire({ seen_at: null }) })];
    renderIntl(<WorkerApplicationsPage />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(ROW_BODY)).toBeInTheDocument();
  });

  it('dismisses one hire without touching another', () => {
    seed = [
      application(),
      application({
        application_id: 'bbbbbbbb-1111-4222-8333-444444444444',
        job_id: 'job-2',
        job_title: 'Concrete Finisher',
        company_name: 'RM Construction',
        hire: hire({ location: 'El Paso, TX', pay: null, start_date: null }),
      }),
    ];
    renderIntl(<WorkerApplicationsPage />);
    expect(screen.getAllByText(ROW_BODY)).toHaveLength(2);

    // One label per banner now, so the first hire is clicked BY NAME rather
    // than by its position among identically-labelled buttons -- which is the
    // whole point of the change.
    fireEvent.click(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Welder' }),
    }));
    expect(screen.getByRole('button', {
      name: interpolate(message('worker_applications.hired_celebration.banner.dismiss'), { title: 'Concrete Finisher' }),
    })).toBeInTheDocument();

    expect(acknowledgeHire).toHaveBeenCalledTimes(1);
    expect(acknowledgeHire).toHaveBeenCalledWith('test-token', APPLICATION_ID, 'dismissed');
    expect(screen.getAllByText(ROW_BODY)).toHaveLength(1);
  });
});
