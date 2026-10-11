import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Every way a session ends goes through AuthContext's `clearSession`, and the
// report buffers go with it: the next person on this phone must not send the
// last person's requests, errors or screens.

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch }));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { getAuthBridge } from '@/lib/auth-bridge';
import {
  clearReportBuffers,
  collectReportContext,
  recordError,
  recordRequest,
  recordScreen,
  type ReportContextV1,
} from '../context';

const EMPLOYER_SLOT = 'jale.session.employer';

function Probe() {
  const { userType, isLoading, logout } = useAuth();
  return (
    <div>
      <span data-testid="state">{isLoading ? 'loading' : `ready:${userType ?? 'none'}`}</span>
      <button type="button" onClick={() => logout()}>sign out</button>
    </div>
  );
}

function context(): Required<ReportContextV1> {
  return collectReportContext({ includeTechnical: true, capture: { outcome: 'none', ms: 0 } }) as Required<ReportContextV1>;
}

function fillBuffers() {
  recordRequest({ method: 'GET', url: '/employer/dashboard', status: 200, ms: 40 });
  recordError({ kind: 'api', message: '500 internal_error' });
  recordScreen('/employer/applicants', {});
}

async function signedInEmployer() {
  localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
  window.history.replaceState(null, '', '/es/employer/dashboard');
  render(
    <AuthProvider locale="es">
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));
}

function expectBuffersEmpty() {
  const ctx = context();
  expect(ctx.requests).toEqual([]);
  expect(ctx.errors).toEqual([]);
  expect(ctx.screens).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  clearReportBuffers();
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ accessToken: 'access', idToken: 'id' }),
  });
});

describe('signing out clears the report buffers', () => {
  it('on sign-out from this tab', async () => {
    await signedInEmployer();
    fillBuffers();
    expect(context().requests).toHaveLength(1);

    await userEvent.setup().click(screen.getByRole('button', { name: 'sign out' }));

    await waitFor(() => expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull());
    expectBuffersEmpty();
  });

  it('when the session expires', async () => {
    await signedInEmployer();
    fillBuffers();

    act(() => getAuthBridge()?.onSessionExpired());

    expectBuffersEmpty();
  });

  it('when another tab signs this role out', async () => {
    await signedInEmployer();
    fillBuffers();

    act(() => {
      localStorage.removeItem(EMPLOYER_SLOT);
      window.dispatchEvent(new StorageEvent('storage', { key: EMPLOYER_SLOT, oldValue: 'rt-employer', newValue: null }));
    });

    expectBuffersEmpty();
  });
});
