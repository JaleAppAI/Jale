// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { ApplicantOverviewItem, ApplicantsOverviewResponse } from '@/lib/api/employer';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/employer/PostJobButton', () => ({ PostJobButton: () => null }));
vi.mock('@/contexts/PostJobContext', () => ({ useJobCreated: () => {} }));
// The board asks the applicants guide on its page view; the inbox is one of its signals.
vi.mock('@/contexts/UnreadMessagesContext', () => ({
  useUnreadMessages: () => ({ loading: false, errorKind: null, items: [] }),
}));
// The row is its own suite's subject; here it only reports a save.
vi.mock('../ApplicantOverviewRow', () => ({
  ApplicantOverviewRow: ({ item, onHireDetailsSaved }: {
    item: ApplicantOverviewItem;
    onHireDetailsSaved?: (id: string, d: unknown) => void;
  }) => (
    <>
      <button type="button" onClick={() => onHireDetailsSaved?.(item.application_id, {
        start_date: '2026-10-20', report_location: null, contact_name: null, contact_phone: null, notes: null, updated_at: 'x',
      })}>
        save {item.application_id}
      </button>
      <button type="button" onClick={() => onHireDetailsSaved?.(item.application_id, null)}>
        clear {item.application_id}
      </button>
    </>
  ),
}));

let seed: ApplicantsOverviewResponse;
vi.mock('@/hooks/usePageData', async () => {
  const react = await import('react');
  return {
    usePageData: () => {
      const [data, setState] = react.useState<ApplicantsOverviewResponse>(() => seed);
      return {
        phase: 'ready' as const, data, empty: false, errorKind: null, refreshing: false, refreshError: null,
        retry: vi.fn(), refresh: vi.fn(),
        setData: (u: (p: ApplicantsOverviewResponse) => ApplicantsOverviewResponse) => setState((p) => u(p)),
      };
    },
  };
});

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerApplicantsPage from '../page';

function row(id: string, over: Partial<ApplicantOverviewItem> = {}): ApplicantOverviewItem {
  return {
    application_id: id, worker_id: `w-${id}`, worker_name: null, job_id: 'j-1', job_title: 'Roofer', job_city: null,
    job_status: 'active', application_status: 'hired', applied_at: '2026-09-01T00:00:00Z', skills: [],
    availability: null, years_experience: null, match_score: null, score_band: null,
    hire_details: null, hire_details_needed: true, ...over,
  };
}

function bannerText(count: number): string {
  const raw = message('employer_applicants.hire_details.banner');
  const form = count === 1 ? /one \{([^}]*)\}/ : /other \{([^}]*)\}/;
  return (raw.match(form)?.[1] ?? '').replace(/#/g, String(count));
}

describe('applicants page — the start-details banner (K4.4)', () => {
  it('counts the hires that still need start details, and drops one when it is saved', () => {
    seed = { applicants: [row('a'), row('b'), row('c', { hire_details_needed: false })], jobs: [], total: 3 };
    renderIntl(<EmployerApplicantsPage />);

    expect(screen.getByText(bannerText(2))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'save a' }));

    expect(screen.getByText(bannerText(1))).toBeInTheDocument();
  });

  it('counts a hire again when a save clears every field', () => {
    seed = { applicants: [row('a'), row('b', { hire_details_needed: false })], jobs: [], total: 2 };
    renderIntl(<EmployerApplicantsPage />);

    expect(screen.getByText(bannerText(1))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'clear b' }));

    expect(screen.getByText(bannerText(2))).toBeInTheDocument();
  });

  it('shows no banner when nobody needs details', () => {
    seed = { applicants: [row('a', { hire_details_needed: false })], jobs: [], total: 1 };
    renderIntl(<EmployerApplicantsPage />);
    expect(screen.queryByText(bannerText(1))).not.toBeInTheDocument();
  });
});
