// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerProfileData, WorkerVaultDoc } from '@/lib/api/worker';
import type { TutorialHandle, UseTutorialOptions } from '@/lib/tutorials/types';

/*
 * W4, the profile tutorial: how the profile page asks for it.
 *
 * Its K1.5 signal is "the worker has any saved document", which this page
 * already loads with the profile. While the page loads, `done` is
 * `undefined`; once it is ready the page asks the tutorial to open itself
 * once. Whether it opens is the hook's decision, so the hook is replaced here
 * by a recorder. The harness is the sibling `facts-card.test.tsx` one.
 */

const { tutorial } = vi.hoisted(() => {
  const handle = {
    maybeAutoOpen: vi.fn(),
    runBeforeHost: vi.fn((openHost: () => void) => openHost()),
    replay: vi.fn(),
  };
  return {
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

vi.mock('@/lib/tutorials/use-tutorial', () => ({ useTutorial: tutorial.useTutorial }));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  redirect: vi.fn(),
  usePathname: () => '/worker/profile',
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The document slots and the media board own their own fetches and are not what
// this suite is about; markers keep a change in either from turning it red.
vi.mock('@/components/worker/DocumentSlot', () => ({
  DocumentSlot: ({ doc_type }: { doc_type: string }) => <div data-doc-slot={doc_type} />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({
  MediaBoardGrid: () => <div data-media-board="grid" />,
}));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));

// `PayReferenceHint` fetches BLS data and renders null without a trade+city.
// Mocked to a marker so "the hint stays beneath the preferred cities" is
// assertable without standing up the pay-reference endpoint.
vi.mock('@/components/PayReferenceHint', () => ({
  PayReferenceHint: () => <div data-pay-hint="worker-profile" />,
}));

/** What the fake page-data hook serves; each test sets it before rendering. */
let pageState: { phase: 'loading' | 'ready'; data: unknown };

vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({
    phase: pageState.phase,
    data: pageState.data,
    empty: false,
    errorKind: null,
    refreshing: false,
    refreshError: null,
    retry: vi.fn(),
    refresh: vi.fn(),
    setData: vi.fn(),
  }),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerProfilePage from '../page';

const PROFILE: WorkerProfileData = {
  id: 'worker-1',
  phone: '+15555550100',
  full_name: 'Test Worker',
  skills: [],
  availability: null,
  years_experience: null,
  location: null,
  bio: null,
  certifications: [],
  preferred_cities: [],
  main_trade: null,
  main_trade_other: null,
} as WorkerProfileData;

const SAVED_DOC = {
  id: 'v1',
  doc_type: 'driver_license',
  file_name: 'fake-license-file.jpg',
  file_size: 1024,
  uploaded_at: '2026-08-20T00:00:00.000Z',
  url: 'https://files.example.invalid/v1',
} as WorkerVaultDoc;

function ready(docs: WorkerVaultDoc[]) {
  return { phase: 'ready' as const, data: { profile: PROFILE, docs, posts: [], next_before: null, next_before_id: null } };
}

function doneSequence(): Array<boolean | undefined> {
  const seen: Array<boolean | undefined> = [];
  for (const [, options] of tutorial.useTutorial.mock.calls) {
    if (seen.length === 0 || seen[seen.length - 1] !== options.done) seen.push(options.done);
  }
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/worker/profile — the W4 tutorial', () => {
  it('passes done undefined while the page loads, and does not ask', () => {
    pageState = { phase: 'loading', data: undefined };
    renderIntl(<WorkerProfilePage />);

    expect(tutorial.useTutorial.mock.calls.every(([id]) => id === 'worker_profile')).toBe(true);
    expect(doneSequence()).toEqual([undefined]);
    expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
  });

  it('asks once, not done, when the loaded profile has no saved documents', () => {
    pageState = { phase: 'loading', data: undefined };
    const { rerender } = renderIntl(<WorkerProfilePage />);
    pageState = ready([]);
    rerender(<WorkerProfilePage />);
    rerender(<WorkerProfilePage />);

    expect(doneSequence()).toEqual([undefined, false]);
    expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
  });

  it('passes done once the worker has a saved document', () => {
    pageState = ready([SAVED_DOC]);
    renderIntl(<WorkerProfilePage />);

    expect(doneSequence()).toEqual([true]);
  });
});
