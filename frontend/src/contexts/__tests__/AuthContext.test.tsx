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
import { ApiError } from '@/lib/api/errors';

const WORKER_SLOT = 'jale.session.worker';
const EMPLOYER_SLOT = 'jale.session.employer';
const LAST_ROLE_KEY = 'jale.session.lastRole';
const WORKER_CHIP = 'jale.sidebar_chip.worker';
const EMPLOYER_CHIP = 'jale.sidebar_chip.employer';

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
    it('an employer sign-out drops the stored invite token (M5); a worker sign-out leaves it', async () => {
        const invite = JSON.stringify({ token: 'tok-1', email: 'ana@example.com' });
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/worker/home');
        sessionStorage.setItem('pendingInvite', invite);
        const user = userEvent.setup();

        const worker = renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker'));
        await user.click(screen.getByRole('button', { name: 'sign out' }));
        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
        // Not the worker's: an employer invite in the same tab stays.
        expect(sessionStorage.getItem('pendingInvite')).toBe(invite);
        worker.unmount();

        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        window.history.replaceState(null, '', '/es/employer/dashboard');
        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));
        await user.click(screen.getByRole('button', { name: 'sign out' }));

        // A live bearer token must not outlast the session on a shared device.
        await waitFor(() => expect(sessionStorage.getItem('pendingInvite')).toBeNull());
    });

    it('a refused (expired) employer token keeps the stored invite: the invite page reads it back after the legal wall', async () => {
        const invite = JSON.stringify({ token: 'tok-1', email: 'ana@example.com' });
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        sessionStorage.setItem('pendingInvite', invite);
        window.history.replaceState(null, '', '/es/auth/employer/invite');
        apiFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

        renderProvider();

        await waitFor(() => expect(localStorage.getItem(EMPLOYER_SLOT)).toBeNull());
        expect(sessionStorage.getItem('pendingInvite')).toBe(invite);
    });

    it('another tab\'s employer sign-out drops this tab\'s stored invite', async () => {
        const invite = JSON.stringify({ token: 'tok-1', email: 'ana@example.com' });
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        sessionStorage.setItem('pendingInvite', invite);
        window.history.replaceState(null, '', '/es/auth/employer/invite');

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));

        // The other tab removed the slot: the browser's storage event.
        localStorage.removeItem(EMPLOYER_SLOT);
        window.dispatchEvent(new StorageEvent('storage', { key: EMPLOYER_SLOT, oldValue: 'rt-employer', newValue: null }));

        await waitFor(() => expect(sessionStorage.getItem('pendingInvite')).toBeNull());
    });

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

    it('drops what the browser remembers about the account that just left', async () => {
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        sessionStorage.setItem(
            'jale.sidebar_chip.employer',
            JSON.stringify({ name: 'NB Construction', meta: null, initials: 'RC', locale: 'es' }),
        );
        // Both billing banners: the free one lives in localStorage, the lapsed
        // one in sessionStorage, and a sign-out has to reach both stores.
        localStorage.setItem('jale.signage.free.employer_free.acct-1', '1');
        sessionStorage.setItem('jale.signage.lapsed.past_due.acct-1', '1');
        // Not ours, and not ours to delete.
        localStorage.setItem('jale-theme', 'dark');
        window.history.replaceState(null, '', '/es/employer/dashboard');
        const user = userEvent.setup();

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer'));
        await user.click(screen.getByRole('button', { name: 'sign out' }));

        // Cleared by `clearSession` itself: `logout` navigates immediately
        // afterwards, so a React effect reacting to the state change is not a
        // guarantee this ever runs.
        await waitFor(() => expect(sessionStorage.getItem('jale.sidebar_chip.employer')).toBeNull());
        // A dismissal is one account's answer; the next account to sign in on
        // this browser has not given one -- least of all about their billing.
        expect(localStorage.getItem('jale.signage.free.employer_free.acct-1')).toBeNull();
        expect(sessionStorage.getItem('jale.signage.lapsed.past_due.acct-1')).toBeNull();
        expect(localStorage.getItem('jale-theme')).toBe('dark');
    });

    it('does not overwrite the other role when signing in', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/auth/employer');
        const user = userEvent.setup();

        renderProvider();
        // The employer login page with only a worker signed in: NOT a worker
        // session in disguise. Restoring the worker here is what sent a click
        // on "employer login" straight to the worker home (2026-09-04).
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none'));
        expect(refreshCalls()).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'sign in as employer' }));

        await waitFor(() => expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-new-employer'));
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(localStorage.getItem(LAST_ROLE_KEY)).toBe('employer');
    });

    it('leaves an employer route signed out when only a worker is stored', async () => {
        // The mirror image for a role PAGE (not just the login door): the
        // employer dashboard must not run on worker tokens. `useRequireAuth`
        // then sends the visitor to the employer login with a return URL.
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/employer/dashboard');

        renderProvider();
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none'));
        expect(refreshCalls()).toEqual([]);
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('drops only the refused role when a stored token no longer works', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        sessionStorage.setItem(WORKER_CHIP, '{"name":"David","meta":null,"initials":"D","locale":"es"}');
        sessionStorage.setItem(EMPLOYER_CHIP, '{"name":"Acme","meta":null,"initials":"A","locale":"es"}');
        window.history.replaceState(null, '', '/es/worker/home');
        // 401 is the pool REFUSING the token -- the one answer that proves the
        // stored session is worthless.
        apiFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

        renderProvider();

        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
        // An expired worker token says nothing about the employer session.
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-employer');
        // ...and the chip cache goes with the session that was refused, so the
        // refused account's name cannot paint for whoever signs in next --
        // while the employer's own cached chip is none of its business.
        expect(sessionStorage.getItem(WORKER_CHIP)).toBeNull();
        expect(sessionStorage.getItem(EMPLOYER_CHIP)).not.toBeNull();
    });

    /*
     * A REFUSAL and an OUTAGE are not the same answer.
     *
     * Every failure used to clear the slot, and since a removed slot is now
     * broadcast to every other tab (the cross-tab sign-out), one timed-out
     * refresh on a phone in a lift signed the whole browser out of a session
     * that was perfectly valid. Only the pool saying "no" may do that.
     */
    it('keeps the session when the refresh never reaches the server', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/worker/home');
        apiFetch.mockRejectedValue(new Error('offline'));

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:'));
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('keeps the session when the refresh answers with an outage', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/worker/home');
        apiFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

        renderProvider();

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:'));
        // A 503 says the server is having a bad day, not that this worker is
        // signed out -- and the next load exchanges the same token happily.
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
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

/*
 * What a renewal REPORTS. The transport (`lib/api.ts`) decides from this
 * whether a 401 ends the session, so "refused", "the server had a bad day"
 * and "no answer at all" must arrive as three different things.
 */
describe('AuthProvider — what a renewal reports', () => {
    const results: unknown[] = [];

    function RenewProbe() {
        const { refreshIdToken, getValidIdTokenOrNull, isLoading, idToken } = useAuth();
        return (
            <div>
                <span data-testid="state">{isLoading ? 'loading' : `ready:${idToken ?? 'none'}`}</span>
                <button
                    type="button"
                    onClick={() => {
                        refreshIdToken().then((r) => results.push(r), (err: unknown) => results.push({ rejected: err }));
                    }}
                >
                    renew
                </button>
                <button
                    type="button"
                    onClick={() => {
                        getValidIdTokenOrNull().then((r) => results.push(r));
                    }}
                >
                    read token
                </button>
            </div>
        );
    }

    /** A JWT-shaped token whose `exp` is `secondsFromNow` away. */
    function tokenExpiringIn(secondsFromNow: number): string {
        const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).replace(/=+$/, '');
        return `header.${payload}.signature`;
    }

    beforeEach(() => {
        results.length = 0;
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        window.history.replaceState(null, '', '/es/worker/home');
        apiFetch.mockReset();
        // The mount restore lands a session first; each test queues the
        // renewal's own answer behind it.
        apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'a-1', idToken: 'id-1' }) });
    });

    async function renewWith(answer: unknown) {
        const user = userEvent.setup();
        render(<AuthProvider locale="es"><RenewProbe /></AuthProvider>);
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:id-1'));
        if (answer instanceof Error) apiFetch.mockRejectedValueOnce(answer);
        else apiFetch.mockResolvedValueOnce(answer);
        await user.click(screen.getByRole('button', { name: 'renew' }));
        await waitFor(() => expect(results).toHaveLength(1));
        return results[0];
    }

    it('reports an outage as unavailable and keeps the session and the token', async () => {
        const result = await renewWith({ ok: false, status: 503, json: async () => ({}) });

        expect(result).toEqual({ status: 'unavailable' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(screen.getByTestId('state')).toHaveTextContent('ready:id-1');
    });

    it('reports a refused token as refused and drops that role only', async () => {
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        const result = await renewWith({ ok: false, status: 401, json: async () => ({}) });

        expect(result).toEqual({ status: 'refused' });
        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-employer');
    });

    it('hands back the new token', async () => {
        const result = await renewWith({ ok: true, status: 200, json: async () => ({ accessToken: 'a-2', idToken: 'id-2' }) });

        expect(result).toEqual({ status: 'ok', token: 'id-2' });
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:id-2'));
    });

    it('rejects when the renewal got no answer, and keeps the session', async () => {
        const result = await renewWith(new ApiError(0, 'offline')) as { rejected: unknown };

        expect(result.rejected).toMatchObject({ status: 0, code: 'offline' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
        expect(screen.getByTestId('state')).toHaveTextContent('ready:id-1');
    });

    it('reports a request fault (400) as refused and drops that role only', async () => {
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');
        const result = await renewWith({ ok: false, status: 400, json: async () => ({}) });

        expect(result).toEqual({ status: 'refused' });
        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
        expect(localStorage.getItem(EMPLOYER_SLOT)).toBe('rt-employer');
    });

    it('reports a throttled renewal (429) as unavailable and keeps the session', async () => {
        const result = await renewWith({ ok: false, status: 429, json: async () => ({}) });

        expect(result).toEqual({ status: 'unavailable' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('reports a forbidden renewal (403) as refused', async () => {
        const result = await renewWith({ ok: false, status: 403, json: async () => ({}) });

        expect(result).toEqual({ status: 'refused' });
        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
    });

    it('reports an unreadable success body as unavailable', async () => {
        const result = await renewWith({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } });

        expect(result).toEqual({ status: 'unavailable' });
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('treats a success without an id token as refused, as before', async () => {
        const result = await renewWith({ ok: true, status: 200, json: async () => ({ accessToken: 'a-2' }) });

        expect(result).toEqual({ status: 'refused' });
        await waitFor(() => expect(localStorage.getItem(WORKER_SLOT)).toBeNull());
    });

    it('lets a token read join a renewal already running, with one request between them', async () => {
        apiFetch.mockReset();
        apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accessToken: 'a-1', idToken: tokenExpiringIn(10) }) });
        let release!: (value: unknown) => void;
        apiFetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
        const user = userEvent.setup();
        render(<AuthProvider locale="es"><RenewProbe /></AuthProvider>);
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:header.'));

        await user.click(screen.getByRole('button', { name: 'renew' }));
        await user.click(screen.getByRole('button', { name: 'read token' }));
        release({ ok: true, status: 200, json: async () => ({ accessToken: 'a-2', idToken: 'id-2' }) });

        await waitFor(() => expect(results).toHaveLength(2));
        expect(results).toEqual(expect.arrayContaining([{ status: 'ok', token: 'id-2' }, 'id-2']));
        // The mount restore, then ONE renewal shared by both callers.
        expect(refreshCalls()).toHaveLength(2);
    });
});
