// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

import type { WorkerProfileData } from '@/lib/api/worker';

/*
 * The trade on `/worker/profile`: shown in the facts card as saved, and
 * changed from the edit form, which saves through `updateWorkerProfile`
 * (PATCH /worker/profile). These tests read the request as it leaves the
 * page, so the body shape is the one the server receives.
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch,
}));
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
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/worker/DocumentSlot', () => ({
  DocumentSlot: ({ doc_type }: { doc_type: string }) => <div data-doc-slot={doc_type} />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({ MediaBoardGrid: () => <div /> }));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => null }));

let seed: { profile: WorkerProfileData; docs: []; posts: []; next_before: null; next_before_id: null };
vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({
    phase: 'ready' as const,
    data: seed,
    empty: false,
    errorKind: null,
    refreshing: false,
    refreshError: null,
    retry: vi.fn(),
    refresh: vi.fn(async () => {}),
    setData: vi.fn(),
  }),
}));

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerProfilePage from '../page';

const PROFILE: WorkerProfileData = {
  id: 'worker-1',
  phone: '+15555550100',
  full_name: 'Test Worker',
  skills: ['Framing'],
  availability: 'part_time',
  years_experience: null,
  location: 'Austin, TX',
  bio: null,
  certifications: [],
  preferred_cities: [],
  main_trade: 'carpenter',
  main_trade_other: null,
};

function seedWith(profile: WorkerProfileData) {
  seed = { profile, docs: [], posts: [], next_before: null, next_before_id: null };
}

/** The Trade tile's value (`dd` beside its `dt`). */
function tradeTile(): HTMLElement {
  const term = screen.getByText(message('worker_profile.field_trade'), { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
}

const e = (key: string) => message(`worker_profile.edit.${key}`);

/** Opens the form, applies `edit`, presses Save, and returns the PATCH body as sent. */
async function saveWith(edit: () => void): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: message('worker_profile.edit_button') }));
  edit();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: e('save') }));
  });
  await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
  const [path, init] = apiFetch.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/worker/profile');
  expect(init.method).toBe('PATCH');
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const trade = () => screen.getByLabelText(e('trade_label')) as HTMLSelectElement;

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
  window.history.replaceState({}, '', '/en/worker/profile');
});

describe('/worker/profile — the trade', () => {
  it('shows the saved standard trade in the facts card', () => {
    seedWith(PROFILE);
    renderIntl(<WorkerProfilePage />);
    expect(tradeTile()).toHaveTextContent(message('worker_vocab.trade.carpenter'));
  });

  it('shows the worker’s own words for a saved Other trade', () => {
    seedWith({ ...PROFILE, main_trade: 'other', main_trade_other: 'Welder' });
    renderIntl(<WorkerProfilePage />);
    expect(tradeTile()).toHaveTextContent('Welder');
  });

  it('shows a muted placeholder when no trade is saved', () => {
    seedWith({ ...PROFILE, main_trade: null });
    renderIntl(<WorkerProfilePage />);
    expect(tradeTile()).toHaveTextContent(message('worker_profile.empty_trade'));
    expect(tradeTile().className).toContain('text-[var(--jale-ink-2)]');
  });

  it('shows the trade in Spanish', () => {
    seedWith(PROFILE);
    renderIntl(<WorkerProfilePage />, 'es');
    expect(within(screen.getByText('Oficio', { selector: 'dt' }).parentElement as HTMLElement).getByText('Carpintero')).toBeInTheDocument();
  });

  it('sends a standard trade with the other text cleared', async () => {
    seedWith({ ...PROFILE, main_trade: 'other', main_trade_other: 'Welder' });
    renderIntl(<WorkerProfilePage />);
    const body = await saveWith(() => fireEvent.change(trade(), { target: { value: 'plumber' } }));
    expect(body).toEqual({
      full_name: 'Test Worker',
      main_trade: 'plumber',
      main_trade_other: null,
      skills: ['Framing'],
      availability: 'part_time',
      location: 'Austin, TX',
      bio: null,
      certifications: [],
      preferred_cities: [],
      lang: 'en',
    });
  });

  it('sends Other with the trimmed text', async () => {
    seedWith(PROFILE);
    renderIntl(<WorkerProfilePage />);
    const body = await saveWith(() => {
      fireEvent.change(trade(), { target: { value: 'other' } });
      fireEvent.change(screen.getByLabelText(e('trade_other_label')), { target: { value: '  Welder  ' } });
    });
    expect(body).toMatchObject({ main_trade: 'other', main_trade_other: 'Welder', lang: 'en' });
  });

  it('sends neither trade field when none is chosen and none is saved', async () => {
    seedWith({ ...PROFILE, main_trade: null, main_trade_other: null });
    renderIntl(<WorkerProfilePage />);
    const body = await saveWith(() => {});
    expect(body).not.toHaveProperty('main_trade');
    expect(body).not.toHaveProperty('main_trade_other');
    // And no number of years the worker never gave.
    expect(body).not.toHaveProperty('years_experience');
  });
});
