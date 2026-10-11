// @vitest-environment jsdom
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * `getValidIdTokenOrNull`: the token for a request that must not leave the
 * page (the report form). It renews a token that is about to expire, and on
 * ANY failure answers null -- it never clears the session and never takes the
 * sign-in redirect, because either would move the page while the person is
 * halfway through describing a problem.
 *
 * "Never cleared" is observed through what clearing does: the stored slot
 * disappears and `sessionCleared.epoch` rises. Both are also the first two
 * steps of the session-expired redirect, so a session that is still stored and
 * never announced as cleared was never sent to the sign-in screen either.
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

function base64url(text: string): string {
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token-shaped value built at runtime: header, payload with `exp`, signature. */
function idTokenExpiringIn(seconds: number, label: string): string {
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, label }));
    return `${header}.${payload}.fake-signature`;
}

function refreshOk(idToken: string) {
    return { ok: true, status: 200, json: async () => ({ accessToken: 'access', idToken }) };
}

function refreshCalls(): number {
    return apiFetch.mock.calls.filter(([path]) => path === '/auth/refresh').length;
}

function Probe() {
    const { getValidIdTokenOrNull, isLoading, isAuthenticated, sessionCleared } = useAuth();
    const [results, setResults] = useState<string[]>([]);
    const ask = async () => {
        const token = await getValidIdTokenOrNull();
        setResults((prev) => [...prev, token ?? 'null']);
    };
    return (
        <div>
            <span data-testid="state">{isLoading ? 'loading' : isAuthenticated ? 'signed-in' : 'signed-out'}</span>
            <span data-testid="cleared">{sessionCleared.epoch}</span>
            <span data-testid="results">{results.join(',')}</span>
            <button type="button" onClick={ask}>ask</button>
            <button type="button" onClick={() => void Promise.all([ask(), ask()])}>ask twice</button>
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

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/es/worker/home');
});

describe('getValidIdTokenOrNull', () => {
    it('hands back the current token while it is fresh, without a request', async () => {
        const fresh = idTokenExpiringIn(3600, 'fresh');
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        apiFetch.mockResolvedValue(refreshOk(fresh));
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-in'));
        expect(refreshCalls()).toBe(1); // the restore on load

        await user.click(screen.getByRole('button', { name: 'ask' }));
        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent(fresh));
        expect(refreshCalls()).toBe(1);
    });

    it('renews a token that is about to expire', async () => {
        const expiring = idTokenExpiringIn(20, 'expiring');
        const renewed = idTokenExpiringIn(3600, 'renewed');
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        apiFetch.mockResolvedValueOnce(refreshOk(expiring)).mockResolvedValueOnce(refreshOk(renewed));
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-in'));
        await user.click(screen.getByRole('button', { name: 'ask' }));

        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent(renewed));
        expect(refreshCalls()).toBe(2);
        expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ refreshToken: 'rt-worker', userType: 'worker' });
    });

    it('answers null when the renewal is refused, and leaves the session where it is', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        apiFetch
            .mockResolvedValueOnce(refreshOk(idTokenExpiringIn(20, 'expiring')))
            .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'invalid_refresh_token' }) });
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-in'));
        await user.click(screen.getByRole('button', { name: 'ask' }));

        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent('null'));
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(screen.getByTestId('cleared')).toHaveTextContent('0');
        expect(screen.getByTestId('state')).toHaveTextContent('signed-in');
    });

    it('answers null when the renewal never reaches the server', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        apiFetch
            .mockResolvedValueOnce(refreshOk(idTokenExpiringIn(20, 'expiring')))
            .mockRejectedValueOnce(new Error('offline'));
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-in'));
        await user.click(screen.getByRole('button', { name: 'ask' }));

        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent('null'));
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(screen.getByTestId('cleared')).toHaveTextContent('0');
    });

    it('answers null with no session at all, without a request', async () => {
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
        await user.click(screen.getByRole('button', { name: 'ask' }));

        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent('null'));
        expect(refreshCalls()).toBe(0);
    });

    it('shares one renewal between callers that ask at the same time', async () => {
        const renewed = idTokenExpiringIn(3600, 'renewed');
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        apiFetch.mockResolvedValueOnce(refreshOk(idTokenExpiringIn(20, 'expiring'))).mockResolvedValue(refreshOk(renewed));
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-in'));
        await user.click(screen.getByRole('button', { name: 'ask twice' }));

        await waitFor(() => expect(screen.getByTestId('results')).toHaveTextContent(`${renewed},${renewed}`));
        expect(refreshCalls()).toBe(2);
    });
});
