// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';

import type { WorkerProfileData, WorkerVaultDoc } from '@/lib/api/worker';
import { resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import {
  dialogCount,
  preparePlayer,
  recordsPosted,
  settle,
  workerProviders,
} from '@/components/tutorials/content/__tests__/worker-player';

/*
 * W4 with the real tutorial: the providers as the app layout mounts them and
 * the real guide host. For a worker with no saved document (K1.5) the profile
 * page opens its step-by-step guide, alone, starting from the page's own Edit
 * button; the slides stay in Help. The harness is the sibling
 * `tutorial.test.tsx` one.
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
  // The guides' own chunk, fetched up front as the provider's preload does.
  await import('@/components/tutorials/GuideHost');
});

/** The app layout's providers, with the toasts the guide host speaks through. */
function providers(locale: 'en' | 'es' = 'en') {
  const Base = workerProviders(locale);
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <Base>
        <ToastProvider>{children}</ToastProvider>
      </Base>
    );
  };
}

/** The guide's card: the last dialog inside the spotlight layer. */
const guideCard = () => {
  const cards = document.querySelectorAll<HTMLElement>('[data-spotlight="worker_profile"] [role="dialog"]');
  return cards.length > 0 ? cards[cards.length - 1] : null;
};
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
  it('opens the step-by-step guide, not the slides, for a worker with no saved document, alone', async () => {
    pageState = ready([]);
    const watch = watchDialogs();
    render(<WorkerProfilePage />, { wrapper: providers() });

    await vi.waitFor(() => expect(guideCard()).not.toBeNull());
    const card = guideCard() as HTMLElement;
    expect(within(card).getByText('Want a hand with your profile?')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Guide me' })).toBeInTheDocument();
    // No slide deck alongside it.
    expect(screen.queryByRole('heading', { name: 'What employers see' })).toBeNull();

    act(() => within(card).getByRole('button', { name: 'Guide me' }).click());
    await settle();
    // The first step points at the page's own Edit button.
    expect(guideCard()?.getAttribute('data-step')).toBe('edit');
    watch.stop();
    expect(watch.most()).toBe(1);
  });

  it('records the guide as skipped when the worker does it alone', async () => {
    pageState = ready([]);
    render(<WorkerProfilePage />, { wrapper: providers() });

    await vi.waitFor(() => expect(guideCard()).not.toBeNull());
    act(() => within(guideCard() as HTMLElement).getByRole('button', { name: 'I’ll do it myself' }).click());
    await settle();

    expect(guideCard()).toBeNull();
    expect(dialogCount()).toBe(0);
    expect(recordsPosted()).toEqual([{ tutorial_id: 'worker_profile', outcome: 'skipped' }]);
  });

  it('says it in Spanish', async () => {
    pageState = ready([]);
    render(<WorkerProfilePage />, { wrapper: providers('es') });

    await vi.waitFor(() => expect(guideCard()).not.toBeNull());
    const card = guideCard() as HTMLElement;
    expect(within(card).getByText('¿Te ayudamos con tu perfil?')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Guíame' })).toBeInTheDocument();
  });

  it('does not open for a worker who has saved a document', async () => {
    pageState = ready([SAVED_DOC]);
    render(<WorkerProfilePage />, { wrapper: providers() });
    await settle();

    expect(dialogCount()).toBe(0);
  });

  it('does not open while the profile is still loading', async () => {
    pageState = { phase: 'loading', data: undefined };
    render(<WorkerProfilePage />, { wrapper: providers() });
    await settle();

    expect(dialogCount()).toBe(0);
  });
});
