// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The feed's city filter. Only a city picked from the list becomes a chip;
 * text typed in the box and never picked used to vanish on Done with nothing
 * said, so the worker believed the feed was filtered by it. Done now refuses,
 * says why, and puts the worker back in the box.
 *
 * The mocks are the sibling `empty-feed.test.tsx` set.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ replace: vi.fn() }),
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

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ preferred_cities: [] }) })),
}));

vi.mock('@/lib/location-search', () => ({
  queryLocations: vi.fn(async () => []),
  locationDatasetFailed: () => false,
}));

const updateWorkerProfile = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/worker')>()),
  getJobs: vi.fn().mockResolvedValue({ jobs: [], other_jobs: [] }),
  updateWorkerProfile: (...args: unknown[]) => updateWorkerProfile(...args),
  getApplications: vi.fn().mockResolvedValue({ applications: [] }),
  acknowledgeHire: vi.fn(),
}));

vi.mock('@/contexts/WorkerAttentionContext', () => ({
  useWorkerAttention: () => ({
    attention: null, count: 0, loading: true, errorKind: null, refresh: async () => {}, forgetHire: () => {},
  }),
}));

import { message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import WorkerHomePage from '../page';

const cityField = () => screen.getByPlaceholderText(message('common.city_multi_placeholder'));
const done = () => screen.getByRole('button', { name: message('worker_home.cities_done') });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  updateWorkerProfile.mockResolvedValue({ preferred_cities: [] });
});

async function openAndType(text: string) {
  const user = userEvent.setup();
  renderIntl(<WorkerHomePage />);
  await user.click(await screen.findByRole('button', { name: message('worker_home.cities_edit') }));
  fireEvent.change(cityField(), { target: { value: text } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  return user;
}

describe('worker feed: a city typed but not picked', () => {
  it('refuses Done, says to pick the city or clear the box, and goes back to the box', async () => {
    const user = await openAndType('El Paso');
    await user.click(done());

    expect(updateWorkerProfile).not.toHaveBeenCalled();
    expect(screen.getByText(message('common.city_multi_unpicked'))).toBeInTheDocument();
    expect(cityField()).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(cityField()).toHaveFocus());
  });

  it('saves once the box is cleared', async () => {
    const user = await openAndType('El Paso');
    await user.click(done());
    expect(updateWorkerProfile).not.toHaveBeenCalled();

    fireEvent.change(cityField(), { target: { value: '' } });
    await user.click(done());
    await waitFor(() => expect(updateWorkerProfile).toHaveBeenCalledTimes(1));
  });
});
