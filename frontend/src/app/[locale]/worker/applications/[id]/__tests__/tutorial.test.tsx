// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';

import type { Application, ApplicationHire, ApplicationRequirementsState, ApplicationsPage } from '@/lib/api/worker';
import type { TutorialHandle, UseTutorialOptions } from '@/lib/tutorials/types';

/*
 * W3, the details tutorial: how the details page asks for it.
 *
 * It explains the stepper, so it is asked for only when the stepper is what
 * the page shows -- never over the hired card or a terminal panel (closed,
 * not selected, already sent, not requested yet). Its K1.5 signal is "any
 * application has its details completed", which this page reads from the
 * worker's applications (up to the 100 the list serves) only in that case.
 * `done` is `undefined` until the read answers and stays so if it fails.
 * Whether the tutorial opens is the hook's decision, so the hook is replaced
 * here by a recorder. The harness is the sibling `hired-branch.test.tsx` one.
 */

const { getApplications, tutorial } = vi.hoisted(() => {
  const handle = {
    maybeAutoOpen: vi.fn(),
    runBeforeHost: vi.fn((openHost: () => void) => openHost()),
    replay: vi.fn(),
  };
  return {
    getApplications: vi.fn(),
    tutorial: {
      handle,
      useTutorial: vi.fn((id: string, options: UseTutorialOptions): TutorialHandle => {
        void id;
        void options;
        return handle;
      }),
    },
  };
});

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

vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getApplications: (...args: unknown[]) => getApplications(...args),
}));
vi.mock('@/lib/tutorials/use-tutorial', () => ({ useTutorial: tutorial.useTutorial }));

let seed: ApplicationRequirementsState | undefined;
vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({ phase: 'ready' as const, data: seed, errorKind: null, retry: vi.fn() }),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerApplicationDetailsPage from '../page';

function state(
  application: Partial<ApplicationRequirementsState['application']>,
  hire: ApplicationHire | null = null,
): ApplicationRequirementsState {
  return {
    hire,
    sent_messages: [{ message_id: 'm1', body: 'Earlier note', sent_at: '2026-10-13T15:00:00Z' }],
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
    // The wire shape the door always sends, even when nothing is left.
    remaining: {
      prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
      counts: { prompts: 0, fields: 0, certifications: 0, docs: 0 }, complete: true,
      uncollectableDocs: [], optionalFields: [], optionalDocs: [],
    },
    next_step: { kind: 'complete' },
  };
}


/** A details request with something still to do: the stepper is what shows. */
function requested(application: Partial<ApplicationRequirementsState['application']> = {}): ApplicationRequirementsState {
  const base = state({
    status: 'details_requested', details_status: 'requested', stage: 'details',
    details_requested_at: '2026-10-01T15:00:00Z', ...application,
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

function pageOf(applications: Partial<Application>[]): ApplicationsPage {
  return {
    applications: applications as Application[],
    next_cursor: null,
    attention: { details_requested: [], unacknowledged_hires: [] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function doneSequence(): Array<boolean | undefined> {
  const seen: Array<boolean | undefined> = [];
  for (const [, options] of tutorial.useTutorial.mock.calls) {
    if (seen.length === 0 || seen[seen.length - 1] !== options.done) seen.push(options.done);
  }
  return seen;
}

const HIRE: ApplicationHire = {
  hired_at: '2026-10-10T15:00:00.000Z', seen_at: null, acknowledged_at: null, start_date: null, location: null,
  shift_schedule: null, pay: null, pay_min: null, pay_max: null, pay_interval: null, details: null,
  employer_reminded_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  seed = undefined;
});

describe('/worker/applications/[id] — the W3 tutorial', () => {
  it('reads up to 100 applications, passes done undefined until it answers, then asks once', async () => {
    const read = deferred<ApplicationsPage>();
    getApplications.mockReturnValue(read.promise);
    seed = requested();

    renderIntl(<WorkerApplicationDetailsPage />);

    expect(tutorial.useTutorial.mock.calls.every(([id]) => id === 'worker_details')).toBe(true);
    await waitFor(() => expect(getApplications).toHaveBeenCalledTimes(1));
    expect(getApplications.mock.calls[0][0]).toBe('test-token');
    expect(getApplications.mock.calls[0][2]).toEqual({ limit: 100 });
    expect(doneSequence()).toEqual([undefined]);
    expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(pageOf([{ application_id: 'app-1', details_completed_at: null }]));
    });

    expect(doneSequence()).toEqual([undefined, false]);
    expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
  });

  it('passes done once any application has its details completed', async () => {
    getApplications.mockResolvedValue(pageOf([
      { application_id: 'app-1', details_completed_at: null },
      { application_id: 'app-0', details_completed_at: '2026-09-01T15:00:00Z' },
    ]));
    seed = requested();
    renderIntl(<WorkerApplicationDetailsPage />);

    await waitFor(() => expect(doneSequence()).toEqual([undefined, true]));
  });

  it('keeps done undefined, and never asks, when the read fails', async () => {
    getApplications.mockRejectedValue(new Error('offline'));
    seed = requested();
    renderIntl(<WorkerApplicationDetailsPage />);

    await waitFor(() => expect(getApplications).toHaveBeenCalled());
    await act(async () => {});
    expect(doneSequence()).toEqual([undefined]);
    expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
  });

  it.each<[string, () => ApplicationRequirementsState]>([
    ['the hired card', () => state({ status: 'hired' }, HIRE)],
    ['details already sent', () => requested({ details_completed_at: '2026-10-02T15:00:00Z' })],
    ['nothing requested yet', () => state({})],
    ['a closed job', () => ({ ...requested(), job: { ...requested().job, status: 'closed' } })],
    ['not selected', () => requested({ status: 'not_interested' })],
  ])('neither reads nor asks over %s', async (_label, build) => {
    getApplications.mockResolvedValue(pageOf([]));
    seed = build();
    renderIntl(<WorkerApplicationDetailsPage />);

    await act(async () => {});
    expect(getApplications).not.toHaveBeenCalled();
    expect(new Set(doneSequence())).toEqual(new Set([undefined]));
    expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
  });
});
