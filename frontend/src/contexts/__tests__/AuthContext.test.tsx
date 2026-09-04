// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * One provider serves BOTH roles, and this product is routinely used with a
 * worker session and an employer session open in the same browser. So the
 * provider must always say which role it is acting for — the storage module
 * keeps a slot each, and these tests are the ones that would catch a regression
 * back to "whatever is stored":
 *
 *   - a worker route restores the worker session even when an employer session
 *     is also stored, and vice versa;
 *   - signing out of one role leaves the other signed in;
 *   - a refused refresh drops only the role whose token was refused.
 *
 * The storage module is NOT mocked here: what is being tested is that the
 * provider addresses the right slot, so the real slots are the assertion.
 */

const { apiFetch, registerAuthBridge, getAuthBridge } = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    registerAuthBridge: vi.fn(),
    getAuthBridge: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ apiFetch }));
vi.mock('@/lib/auth-bridge', () => ({ registerAuthBridge, getAuthBridge }));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const WORKER_SLOT = 'jale.session.worker';
const EMPLOYER_SLOT = 'jale.session.employer';
const LAST_ROLE_KEY = 'jale.session.lastRole';

function Probe() {
    const { userType, isLoading, logout, setTokens } = useAuth();
    return (
        <div>
            <span data-testid="state">{isLoading ? 'loading' : `ready:${userType ?? 'none'}`}</span>
            <button type="button" onClick={() => logout()}>sign out</button>
            <button
                type="button"
                onClick={() => setTokens({ accessToken: 'a', idToken: 'i', refreshToken: 'rt-new-employer' }, 'employer')}
            >
                sign in as employer
            </button>
        </div>
    );
}

function renderProvider() {
    return render(
        <AuthProvider locale="es">
            <Probe />
        </AuthProvider>,
    );
}

/** The refresh bodies the provider POSTed, in order. */
function refreshCalls(): Array<{ refreshToken?: string; userType?: string }> {
    return apiFetch.mock.calls
        .filter(([path]) => path === '/auth/refresh')
        .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    apiFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ accessToken: 'access', idToken: 'id' }),
    });
    window.history.replaceState(null, '', '/es/');
});

describe('AuthProvider — two roles in one browser', () => {
    beforeEach(() => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        localStorage.setItem(LAST_ROLE_KEY, 'employer');
    });

    it('restores the worker session on a worker route', async () => {
        window.history.replaceState(null, '', '/es/worker/home');

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker'));
        expect(refreshCalls()).toEqual([{ refreshToken: 'rt-worker', userType: 'worker' }]);
    });

    it('restores the employer session on an employer route', async () => {
        window.history.replaceState(null, '', '/es/employer/dashboard');

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));
        expect(refreshCalls()).toEqual([{ refreshToken: 'rt-employer', userType: 'employer' }]);
    });

    it('uses the most recent sign-in where the route names no role', async () => {
        localStorage.setItem(LAST_ROLE_KEY, 'worker');

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker'));
        expect(refreshCalls()).toEqual([{ refreshToken: 'rt-worker', userType: 'worker' }]);
    });
});

describe('AuthProvider — signing out', () => {
    it('leaves the other role signed in', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        window.history.replaceState(null, '', '/es/employer/dashboard');
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));
        await user.click(screen.getByRole('button', { name: 'sign out' }));

        await waitFor(() => expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull());
        // The worker in the next tab did not ask to be signed out.
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('does not overwrite the other role when signing in', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/auth/employer');
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker'));
        await user.click(screen.getByRole('button', { name: 'sign in as employer' }));

        await waitFor(() => expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-new-employer'));
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(localStorage.getItem(LAST_ROLE_KEY)).toBe('employer');
    });

    it('drops only the refused role when a stored token no longer works', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        window.history.replaceState(null, '', '/es/worker/home');
        apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });

        renderProvider();

        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
        // An expired worker token says nothing about the employer session.
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-employer');
    });
});

describe('AuthProvider — a session from an older build', () => {
    it('migrates it into its role slot and refreshes it', async () => {
        sessionStorage.setItem('refreshToken', 'rt-old');
        sessionStorage.setItem('userType', 'worker');
        window.history.replaceState(null, '', '/es/worker/home');

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker'));
        expect(refreshCalls()).toEqual([{ refreshToken: 'rt-old', userType: 'worker' }]);
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-old');
        expect(sessionStorage.getItem('refreshToken')).toBeNull();
    });

    it('stays signed out when there is nothing stored at all', async () => {
        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none'));
        expect(refreshCalls()).toEqual([]);
    });
});
