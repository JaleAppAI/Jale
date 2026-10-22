// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'app-1', locale: 'en' }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/worker/application-requirements/ApplicationRequirementsFlow', () => ({
  ApplicationRequirementsFlow: () => <div data-testid="requirements-flow" />,
}));
vi.mock('@/components/worker/HiredCard', () => ({
  HiredCard: ({ applicationId, sentMessages }: { applicationId: string; sentMessages: Array<{ body: string }> }) => (
    <div data-testid="hired-card">{applicationId}|{sentMessages?.map((m) => m.body).join(',')}</div>
  ),
}));

// The page reads the worker's applications for the W3 tutorial's signal when
// the stepper shows; stubbed so the real fetch never runs here.
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: vi.fn(async () => ({
    applications: [], next_cursor: null, attention: { details_requested: [], unacknowledged_hires: [] },
  })),
}));

let seed: unknown;
vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({ phase: 'ready' as const, data: seed, errorKind: null, retry: vi.fn() }),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerApplicationDetailsPage from '../page';

function state(application: Record<string, unknown>, hire: unknown = null) {
  return {
    hire,
    sent_messages: [{ message_id: 'm1', body: 'Earlier note', sent_at: '2026-10-13T15:00:00Z' }],
    application: {
      id: 'app-1', job_id: 'job-1', status: 'pending', details_status: 'not_requested', stage: 'applied',
      details_requested_at: null, details_completed_at: null, applied_at: null, updated_at: null,
      ...application,
    },
    job: {
      id: 'job-1', title: 'Welder', company_name: 'Bravo Co', status: 'active', required_fields: [], optional_fields: [],
      required_docs: [], optional_docs: [], certification_requirements: [], pre_application_prompts: [],
    },
    answers: {}, certifications: [], prompt_answers: {}, documents: [],
    // The wire shape the door always sends, even when nothing is left.
    remaining: {
      prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
      counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 }, complete: true, uncollectable_docs: [],
    },
    next_step: { kind: 'complete' },
  };
}

const HIRE = {
  hired_at: '2026-10-10T15:00:00.000Z', seen_at: null, acknowledged_at: null, start_date: null, location: null,
  shift_schedule: null, pay: null, pay_min: null, pay_max: null, pay_interval: null, details: null,
  employer_reminded_at: null,
};

beforeEach(() => { seed = undefined; });

describe('/worker/applications/[id] — the hired branch', () => {
  it('shows the hired card for a hired application that carries its hire', () => {
    seed = state({ status: 'hired' }, HIRE);
    renderIntl(<WorkerApplicationDetailsPage />);
    expect(screen.getByTestId('hired-card')).toHaveTextContent('app-1');
    expect(screen.getByTestId('hired-card')).toHaveTextContent('Earlier note');
    expect(screen.queryByTestId('requirements-flow')).not.toBeInTheDocument();
  });

  it('keeps today\'s flow for a hired application from a backend that sends no hire', () => {
    const legacy: Record<string, unknown> = state({ status: 'hired' });
    delete legacy.hire;
    seed = legacy;
    renderIntl(<WorkerApplicationDetailsPage />);
    expect(screen.getByTestId('requirements-flow')).toBeInTheDocument();
  });

  it('keeps the flow for every other status', () => {
    seed = state({ status: 'details_requested' });
    renderIntl(<WorkerApplicationDetailsPage />);
    expect(screen.getByTestId('requirements-flow')).toBeInTheDocument();
  });
});
