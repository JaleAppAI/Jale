// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

import type { WorkerProfileData, WorkerVaultDoc } from '@/lib/api/worker';
import { resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import {
  dialogCount,
  preparePlayer,
  recordsPosted,
  settle,
  walkToLast,
  workerProviders,
} from '@/components/tutorials/content/__tests__/worker-player';

/*
 * W4 with the real tutorial: the providers as the app layout mounts them and
 * the real player and content. "Your profile" opens on the profile page for a
 * worker with no saved document (K1.5), alone, and ends on the common "Got
 * it". The harness is the sibling `tutorial.test.tsx` one.
 */

vi.mock('@/contexts/AuthContext', async () => ({
  useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('@/i18n/navigation', async () => ({
  usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  redirect: vi.fn(),
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
vi.mock('@/components/worker/DocumentSlot', () => ({
  DocumentSlot: ({ doc_type }: { doc_type: string }) => <div data-doc-slot={doc_type} />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({
  MediaBoardGrid: () => <div data-media-board="grid" />,
}));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => null }));

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

import WorkerProfilePage from '../page';

const PROFILE = {
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

let restorePlayer: () => void;
beforeAll(async () => {
  restorePlayer = await preparePlayer();
});
afterAll(() => restorePlayer());

beforeEach(() => {
  vi.clearAllMocks();
  resetHarness();
  window.sessionStorage.clear();
  document.body.style.overflow = '';
  route.path = '/worker/profile';
  signIn('worker');
  serveTutorials([]);
});

describe('profile page with the real W4 tutorial', () => {
  it('opens "Your profile" for a worker with no saved document, alone, and ends on "Got it"', async () => {
    pageState = ready([]);
    const watch = watchDialogs();
    render(<WorkerProfilePage />, { wrapper: workerProviders() });

    const dialog = await screen.findByRole('dialog', { name: 'Your profile' });
    expect(within(dialog).getByRole('heading', { name: 'This is what employers see' })).toBeInTheDocument();
    const gotIt = walkToLast(dialog, 'Next', 'Got it');
    act(() => gotIt.click());
    await settle();
    watch.stop();

    expect(dialogCount()).toBe(0);
    expect(watch.most()).toBe(1);
    expect(recordsPosted()).toEqual([{ tutorial_id: 'worker_profile', outcome: 'completed' }]);
  });

  it('says it in Spanish', async () => {
    pageState = ready([]);
    render(<WorkerProfilePage />, { wrapper: workerProviders('es') });

    const dialog = await screen.findByRole('dialog', { name: 'Tu perfil' });
    expect(walkToLast(dialog, 'Siguiente', 'Entendido')).toBeInTheDocument();
  });

  it('does not open for a worker who has saved a document', async () => {
    pageState = ready([SAVED_DOC]);
    render(<WorkerProfilePage />, { wrapper: workerProviders() });
    await settle();

    expect(dialogCount()).toBe(0);
  });

  it('does not open while the profile is still loading', async () => {
    pageState = { phase: 'loading', data: undefined };
    render(<WorkerProfilePage />, { wrapper: workerProviders() });
    await settle();

    expect(dialogCount()).toBe(0);
  });
});
