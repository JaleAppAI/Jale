// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * An empty feed with no filters on is not a dead end: the one thing a worker
 * can do about it is widen where they look, so the empty state opens the city
 * picker above the list. It only ever OPENS it -- pressing it again must not
 * close the picker and throw away a half-built list -- and it takes the worker
 * there: scrolled into view, focus in the field.
 *
 * The mocks are the sibling `filter-url.test.tsx` set.
 */

const searchParams = { current: new URLSearchParams() };
const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams.current,
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace }),
  usePathname: () => '/worker/home',
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({
    idToken: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    handleLegalWall: (err: unknown) => { throw err; },
  }),
}));

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The saved-cities read: a profile with no cities unless a test says otherwise.
const profile = { current: { preferred_cities: [] as Array<Record<string, string>> } };
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => profile.current })),
}));

vi.mock('@/lib/location-search', () => ({
  queryLocations: vi.fn(async () => []),
  locationDatasetFailed: () => false,
}));

const getJobs = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getJobs: (...args: unknown[]) => getJobs(...args),
  updateWorkerProfile: vi.fn(),
  getApplications: vi.fn().mockResolvedValue({ applications: [] }),
  acknowledgeHire: vi.fn(),
}));

// The attention summary is the session context's (F27); this suite is about
// the feed filters, so the context is served empty.
vi.mock('@/contexts/WorkerAttentionContext', () => ({
  useWorkerAttention: () => ({
    attention: null, count: 0, loading: true, errorKind: null, refresh: async () => {}, forgetHire: () => {},
  }),
}));

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerHomePage from '../page';


const cityField = () => screen.queryByPlaceholderText(message('common.city_multi_placeholder'));

/** jsdom's own `scrollIntoView` (it has none), as this file found it. */
const SCROLL_INTO_VIEW = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

/**
 * jsdom has no `scrollIntoView`, so `vi.spyOn` has nothing to wrap: a
 * stand-in goes on the prototype for one test and `afterEach` puts the
 * prototype back exactly as it was.
 */
function stubScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
  return scrollIntoView;
}

afterEach(() => {
  if (SCROLL_INTO_VIEW) Object.defineProperty(Element.prototype, 'scrollIntoView', SCROLL_INTO_VIEW);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
  sessionStorage.clear();
  profile.current = { preferred_cities: [] };
  getJobs.mockResolvedValue({ jobs: [], other_jobs: [] });
});

describe('worker feed — empty, no filters', () => {
  it('offers to pick cities when the worker has none, and opens the picker there', async () => {
    const user = userEvent.setup();
    const scrollIntoView = stubScrollIntoView();
    renderIntl(<WorkerHomePage />);

    const cta = await screen.findByRole('button', { name: message('worker_home.empty.cta') });
    expect(cityField()).not.toBeInTheDocument();

    await user.click(cta);

    expect(cityField()).toBeInTheDocument();
    await waitFor(() => expect(cityField()).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('only ever opens the picker: a second press keeps it open', async () => {
    const user = userEvent.setup();
    renderIntl(<WorkerHomePage />);

    const cta = await screen.findByRole('button', { name: message('worker_home.empty.cta') });
    await user.click(cta);
    await user.click(cta);

    expect(cityField()).toBeInTheDocument();
  });

  it('says "edit" instead when the worker already has cities', async () => {
    profile.current = { preferred_cities: [{ city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }] };
    renderIntl(<WorkerHomePage />);

    await screen.findByText('El Paso, TX');
    const ctas = await screen.findAllByRole('button', { name: message('worker_home.cities_edit') });
    // The chip row's own toggle, and the empty state's action.
    expect(ctas).toHaveLength(2);
    expect(screen.queryByRole('button', { name: message('worker_home.empty.cta') })).not.toBeInTheDocument();
  });

  it('says it in Spanish', async () => {
    renderIntl(<WorkerHomePage />, 'es');
    expect(await screen.findByRole('button', { name: message('worker_home.empty.cta', 'es') })).toBeInTheDocument();
  });
});

// Runs last in this file: the stand-in for the scroll call above is gone
// again, so no later test sees a scroll function jsdom does not have.
describe('worker feed — test environment', () => {
  it('leaves Element.prototype.scrollIntoView as it found it', () => {
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')).toEqual(SCROLL_INTO_VIEW);
  });
});
