// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Switching ROLES inside one browser tab, and losing a session in another one.
 *
 * `AuthContext.test.tsx` covers the two-slot store on a fresh load. This suite
 * covers what happens AFTER that load, which is where both bugs lived:
 *
 *   - a client-side navigation from a worker route to an employer route left
 *     the provider serving the session it restored on mount, so the employer
 *     page fetched with the worker's id token and got a 401/403 until the
 *     visitor reloaded by hand;
 *   - a sign-out in one tab left every other tab holding a working id token
 *     until its next refresh happened to notice the slot was gone.
 *
 * The first is asserted from a RENDER LOG rather than from the fetches a page
 * happens to make: the guarantee is that the wrong role's token is never
 * HANDED OUT, which is a property of every render, not of one component's
 * effect ordering.
 */

const state = { pathname: '/es/worker/home' };

const { apiFetch, registerAuthBridge, getAuthBridge } = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    registerAuthBridge: vi.fn(),
    getAuthBridge: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ apiFetch }));
vi.mock('@/lib/auth-bridge', () => ({ registerAuthBridge, getAuthBridge }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));

// Imported after the mocks, like the sibling suite.
const { AuthProvider } = await import('@/contexts/AuthContext');

const WORKER_SLOT = 'jale.session.worker';
const EMPLOYER_SLOT = 'jale.session.employer';

/** Every {route, role, token} triple the provider has ever exposed. */
const renderLog: Array<{ pathname: string; userType: string | null; idToken: string | null }> = [];

function Probe() {
    const { userType, idToken, isLoading } = useAuth();
    renderLog.push({ pathname: state.pathname, userType: userType ?? null, idToken: idToken ?? null });
    return (
        <span data-testid="state">
            {isLoading ? 'loading' : `ready:${userType ?? 'none'}:${idToken ?? 'none'}`}
        </span>
    );
}

function tree() {
    return (
        <AuthProvider locale="es">
            <Probe />
        </AuthProvider>
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
    renderLog.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    state.pathname = '/es/worker/home';
    window.history.replaceState(null, '', '/es/worker/home');
    // One id token per POOL, so a token in the wrong page is self-evident.
    apiFetch.mockImplementation(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
            ok: true,
            json: async () => ({ accessToken: `access-${body.userType}`, idToken: `id-${body.userType}` }),
        };
    });
});

describe('AuthProvider — switching roles without a reload', () => {
    it('hands each route its own role token and never the other one', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        const { rerender } = render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        // The client-side navigation: same tab, same provider, new route.
        state.pathname = '/es/employer/dashboard';
        window.history.replaceState(null, '', '/es/employer/dashboard');
        rerender(tree());

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer:id-employer'));
        expect(refreshCalls()).toEqual([
            { refreshToken: 'rt-worker', userType: 'worker' },
            { refreshToken: 'rt-employer', userType: 'employer' },
        ]);
        // The whole point: at no instant did an employer route hold the
        // worker's token (or the reverse). A page that fetched on such a
        // render is the 401 this fixes.
        const crossed = renderLog.filter((entry) => {
            const route = entry.pathname.includes('/employer') ? 'employer' : 'worker';
            return entry.idToken !== null && entry.idToken !== `id-${route}`;
        });
        expect(crossed).toEqual([]);
    });

    it('drops the session on a route whose role is not signed in', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');

        const { rerender } = render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        state.pathname = '/es/employer/dashboard';
        window.history.replaceState(null, '', '/es/employer/dashboard');
        rerender(tree());

        // Signed out for THIS route -- which is what makes useRequireAuth send
        // the visitor to the employer door instead of running the dashboard on
        // worker tokens.
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none:none'));
        expect(refreshCalls()).toEqual([{ refreshToken: 'rt-worker', userType: 'worker' }]);
        // ...and the worker session is still there for the worker routes.
        expect(localStorage.getItem(WORKER_SLOT)).toBe('rt-worker');
    });

    it('restores the other role again on the way back', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        const { rerender } = render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        state.pathname = '/es/employer/dashboard';
        rerender(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:employer:id-employer'));

        state.pathname = '/es/worker/home';
        rerender(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));
        expect(refreshCalls().map((c) => c.userType)).toEqual(['worker', 'employer', 'worker']);
    });

    it('leaves a route that names no role on the session it already has', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');

        const { rerender } = render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        // The landing page, the legal pages: no role to switch to, so nothing
        // is torn down and nothing is refreshed a second time.
        state.pathname = '/es/';
        rerender(tree());

        expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker');
        expect(refreshCalls()).toHaveLength(1);
    });
});

describe('AuthProvider — a sign-out in another tab', () => {
    it('drops the session when this role\'s slot is cleared elsewhere', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');

        render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        // What the browser fires in EVERY OTHER tab when clearSession removes
        // the slot. The tab that signed out gets no event of its own.
        localStorage.removeItem(WORKER_SLOT);
        window.dispatchEvent(new StorageEvent('storage', {
            key: WORKER_SLOT,
            oldValue: 'rt-worker',
            newValue: null,
        }));

        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:none:none'));
    });

    it('ignores the other role being signed out', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');
        localStorage.setItem(EMPLOYER_SLOT, 'rt-employer');

        render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        localStorage.removeItem(EMPLOYER_SLOT);
        window.dispatchEvent(new StorageEvent('storage', {
            key: EMPLOYER_SLOT,
            oldValue: 'rt-employer',
            newValue: null,
        }));

        // The employer signing out in another tab is none of this worker's
        // business -- that is the whole reason the slots are keyed.
        expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker');
    });

    it('ignores a token ROTATION in another tab', async () => {
        localStorage.setItem(WORKER_SLOT, 'rt-worker');

        render(tree());
        await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker'));

        // Cognito rotates the refresh token on every exchange, so another tab
        // WRITING this slot is the most common storage event of all. Treating
        // a write as a sign-out would log the whole browser out every few
        // minutes.
        window.dispatchEvent(new StorageEvent('storage', {
            key: WORKER_SLOT,
            oldValue: 'rt-worker',
            newValue: 'rt-worker-rotated',
        }));

        expect(screen.getByTestId('state')).toHaveTextContent('ready:worker:id-worker');
    });
});
