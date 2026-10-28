// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { Application, ApplicationHire, ApplicationRequirementsState, ApplicationsPage } from '@/lib/api/worker';
import { useTutorialProgress } from '@/lib/tutorials/progress';
import { record, resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import {
  dialogCount,
  preparePlayer,
  recordsPosted,
  settle,
  walkToLast,
  workerProviders,
} from '@/components/tutorials/content/__tests__/worker-player';

/*
 * W3 with the real tutorial: the providers as the app layout mounts them and
 * the real player, guide and content. Over the details stepper, for a worker
 * who has never completed a details request (K1.5), the step-by-step guide
 * opens, alone, on its intro; Help's Play still shows the slides, whose last
 * button reads "Start". Nothing opens over the hired card or a terminal
 * panel. The flow is a stand-in carrying the guide's marks for its panel and
 * its overview (the guide's own suite drives the real flow). The harness is
 * the sibling `tutorial.test.tsx`.
 */

const { getApplications } = vi.hoisted(() => ({ getApplications: vi.fn() }));

vi.mock('@/contexts/AuthContext', async () => ({
  useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'app-1', locale: 'en' }) }));
vi.mock('@/i18n/navigation', async () => ({
  usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const harness = await import('@/lib/tutorials/__tests__/harness');
  return {
    ...(await importOriginal<typeof import('@/lib/api')>()),
    apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
  };
});
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/worker/application-requirements/ApplicationRequirementsFlow', () => ({
  ApplicationRequirementsFlow: () => (
    <div data-testid="requirements-flow" data-guide="details.flow" data-panel="details" data-vault="ready">
      <div data-guide="details.overview">Progress and steps</div>
    </div>
  ),
}));
vi.mock('@/components/worker/HiredCard', () => ({
  HiredCard: () => <div data-testid="hired-card" />,
}));
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: (...args: unknown[]) => getApplications(...args),
}));

let seed: ApplicationRequirementsState | undefined;
vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({ phase: 'ready' as const, data: seed, errorKind: null, retry: vi.fn() }),
}));

import WorkerApplicationDetailsPage from '../page';

function state(
  application: Partial<ApplicationRequirementsState['application']>,
  hire: ApplicationHire | null = null,
): ApplicationRequirementsState {
  return {
    hire,
    sent_messages: [],
    application: {
      id: 'app-1', job_id: 'job-1', status: 'pending', details_status: 'not_requested', stage: 'apply',
      details_requested_at: null, details_completed_at: null, applied_at: null, updated_at: null,
      ...application,
    },
    job: {
      id: 'job-1', title: 'Welder', company_name: 'Bravo Co', status: 'active', required_fields: [], optional_fields: [],
      required_docs: [], optional_docs: [], certification_requirements: [], pre_application_prompts: [],
    },
    answers: {}, certifications: [], prompt_answers: {}, documents: [],
    remaining: {
      prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
      counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 }, complete: true,
      uncollectableDocs: [], optionalFields: [], optionalDocs: [],
    },
    next_step: { kind: 'complete' },
  };
}

/** A details request with something still to do: the stepper is what shows. */
function requested(): ApplicationRequirementsState {
  const base = state({
    status: 'details_requested', details_status: 'requested', stage: 'details',
    details_requested_at: '2026-10-01T15:00:00Z',
  });
  return {
    ...base,
    remaining: {
      prompts: [], fields: ['date_available'], certifications: { unclaimed: [], unproven: [] }, docs: [],
      counts: { prompts: 0, fields: 1, certifications: 0, docs: 0 }, complete: false,
      uncollectableDocs: [], optionalFields: [], optionalDocs: [],
    },
    next_step: { kind: 'fields' },
  };
}

const HIRE: ApplicationHire = {
  hired_at: '2026-10-10T15:00:00.000Z', seen_at: null, acknowledged_at: null, start_date: null, location: null,
  shift_schedule: null, pay: null, pay_min: null, pay_max: null, pay_interval: null, details: null,
  employer_reminded_at: null,
};

function pageOf(applications: Partial<Application>[]): ApplicationsPage {
  return {
    applications: applications as Application[],
    next_cursor: null,
    attention: { details_requested: [], unacknowledged_hires: [] },
  };
}

let restorePlayer: () => void;
beforeAll(async () => {
  restorePlayer = await preparePlayer();
  await import('@/components/tutorials/GuideHost');
});

/** Help's Play: a replay with no renderer named, as `HelpCenter` asks for it. */
function HelpPlay() {
  const progress = useTutorialProgress();
  return (
    <button type="button" onClick={() => progress?.play({ id: 'worker_details', mode: 'replay', vars: progress.varsFor('worker_details') })}>
      Play from Help
    </button>
  );
}

const callout = () => document.querySelector('[data-spotlight] [role="dialog"][data-step]');
afterAll(() => restorePlayer());

beforeEach(() => {
  vi.clearAllMocks();
  resetHarness();
  window.sessionStorage.clear();
  document.body.style.overflow = '';
  route.path = '/worker/applications/app-1';
  signIn('worker');
  serveTutorials([]);
  getApplications.mockResolvedValue(pageOf([{ application_id: 'app-1', details_completed_at: null }]));
  seed = requested();
});

describe('details page with the real W3 tutorial', () => {
  it('opens the step-by-step guide over the stepper, alone, instead of the slides', async () => {
    const watch = watchDialogs();
    render(<WorkerApplicationDetailsPage />, { wrapper: workerProviders() });

    const intro = await screen.findByRole('dialog', { name: 'Want a hand with your details?' });
    expect(screen.getByTestId('requirements-flow')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Details requested' })).not.toBeInTheDocument();

    act(() => within(intro).getByRole('button', { name: 'Guide me' }).click());
    await settle();
    expect(callout()?.getAttribute('data-step')).toBe('overview');

    act(() => within(callout() as HTMLElement).getByRole('button', { name: 'End guide' }).click());
    await settle();
    watch.stop();

    expect(dialogCount()).toBe(0);
    expect(watch.most()).toBe(1);
    expect(recordsPosted()).toEqual([{ tutorial_id: 'worker_details', outcome: 'skipped' }]);
  });

  it('says it in Spanish', async () => {
    render(<WorkerApplicationDetailsPage />, { wrapper: workerProviders('es') });

    const intro = await screen.findByRole('dialog', { name: '¿Te ayudamos con tus datos?' });
    expect(within(intro).getByRole('button', { name: 'Guíame' })).toBeInTheDocument();
  });

  it('keeps the slides for Help\'s Play, ending on "Start"', async () => {
    serveTutorials([record('worker_details', 'skipped')]);
    render(<><WorkerApplicationDetailsPage /><HelpPlay /></>, { wrapper: workerProviders() });
    await settle();
    expect(dialogCount()).toBe(0);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Play from Help' })));
    const dialog = await screen.findByRole('dialog', { name: 'Details requested' });
    expect(within(dialog).getByRole('heading', { name: 'An employer wants to hire you' })).toBeInTheDocument();
    expect(walkToLast(dialog, 'Next', 'Start')).toBeInTheDocument();
    expect(callout()).toBeNull();
  });

  it('does not open for a worker who has completed a details request before', async () => {
    getApplications.mockResolvedValue(pageOf([
      { application_id: 'app-1', details_completed_at: null },
      { application_id: 'app-0', details_completed_at: '2026-09-01T15:00:00Z' },
    ]));
    render(<WorkerApplicationDetailsPage />, { wrapper: workerProviders() });
    await settle();

    expect(dialogCount()).toBe(0);
  });

  it('does not open again once the account has a record for it', async () => {
    serveTutorials([record('worker_details', 'skipped')]);
    render(<WorkerApplicationDetailsPage />, { wrapper: workerProviders() });
    await settle();

    expect(dialogCount()).toBe(0);
    expect(recordsPosted()).toEqual([]);
  });

  it('never opens over the hired card', async () => {
    seed = state({ status: 'hired' }, HIRE);
    render(<WorkerApplicationDetailsPage />, { wrapper: workerProviders() });
    await settle();

    expect(screen.getByTestId('hired-card')).toBeInTheDocument();
    expect(dialogCount()).toBe(0);
  });
});
