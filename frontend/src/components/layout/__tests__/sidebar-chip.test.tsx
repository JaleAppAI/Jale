// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

/*
 * The "W" emblem bug, in one sentence: every worker/employer page mounts its
 * own `AppShell`, the chip's profile fetch lived inside it, and the chip drew
 * the pre-fetch state as a bare role letter -- so every navigation and every
 * reload replaced the employer's name with a "W" until a fresh request came
 * back, and a slow or failed one left it there.
 *
 * Two of these tests are the regression: the fetch now happens ONCE per
 * session no matter how many shells mount (the cache), and the pre-fetch state
 * is a skeleton rather than a letter (the emblem itself).
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
}));

/** Mutable so a test can rotate the token or sign the session out mid-render. */
const authState = {
    idToken: 'token-1' as string | null,
    isAuthenticated: true,
    isLoading: false,
    /**
     * What AuthContext announces when it CLEARS a session, and the only thing
     * that drops a cached chip. An epoch rather than an inference: "not
     * authenticated" is also what a role switch and a role the browser has no
     * session for look like, and neither is a sign-out.
     */
    sessionCleared: { epoch: 0, role: null as 'worker' | 'employer' | null },
    logout: vi.fn(),
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { SidebarProfileProvider } from '@/contexts/SidebarProfileContext';
import { AppShell } from '../AppShell';
import { Sidebar } from '../Sidebar';

const CHIP_KEY = 'jale.sidebar_chip.worker';

function workerProfileResponse() {
    return {
        ok: true,
        json: async () => ({ full_name: 'David Ramos', main_trade: 'concrete', city: 'El Paso' }),
    };
}

function shell(children: ReactNode = 'page') {
    return (
        <SidebarProfileProvider>
            <AppShell role="worker" title="Page">{children}</AppShell>
        </SidebarProfileProvider>
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    authState.idToken = 'token-1';
    authState.isAuthenticated = true;
    authState.isLoading = false;
    authState.sessionCleared = { epoch: 0, role: null };
    apiFetch.mockResolvedValue(workerProfileResponse());
});

describe('sidebar profile chip', () => {
    it('fetches the profile once across two shell mounts', async () => {
        renderIntl(
            <SidebarProfileProvider>
                <AppShell role="worker" title="One">one</AppShell>
                <AppShell role="worker" title="Two">two</AppShell>
            </SidebarProfileProvider>,
        );

        await waitFor(() => expect(screen.getAllByText('David Ramos').length).toBe(2));
        expect(apiFetch).toHaveBeenCalledTimes(1);
    });

    it('renders a skeleton tile, never the bare role letter, while loading', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={{ status: 'loading' }} />);
        expect(screen.queryByText('W')).not.toBeInTheDocument();
    });

    it('still names the role when the profile could not be loaded at all', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={{ status: 'failed' }} />);
        expect(screen.getByText('W')).toBeInTheDocument();
        expect(screen.getByText(message('app_shell.worker_role'))).toBeInTheDocument();
    });

    it('paints the stored chip on a reload, before any request answers', () => {
        sessionStorage.setItem(
            CHIP_KEY,
            JSON.stringify({ name: 'David Ramos', meta: 'Concrete · El Paso', initials: 'DR', locale: 'en' }),
        );
        // No token yet: exactly the window a hard reload sits in while
        // /auth/refresh is still out.
        authState.idToken = null;
        apiFetch.mockImplementation(() => new Promise(() => {}));

        renderIntl(shell());

        // Synchronously, on the first paint -- not after a `waitFor`.
        expect(screen.getByText('David Ramos')).toBeInTheDocument();
        expect(screen.getByText('Concrete · El Paso')).toBeInTheDocument();
        expect(apiFetch).not.toHaveBeenCalled();
    });

    it('keeps the loaded chip when a later revalidation fails', async () => {
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());

        // A rotated id token revalidates in the background -- and this one 500s.
        apiFetch.mockRejectedValue(new Error('offline'));
        authState.idToken = 'token-2';
        rerender(shell('again'));

        await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
        expect(screen.getByText('David Ramos')).toBeInTheDocument();
        expect(screen.queryByText(message('app_shell.worker_role'))).not.toBeInTheDocument();
    });

    it('keeps the cache through a role switch, which masks the session without ending it', async () => {
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());
        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();

        // AuthContext re-reading the other role's slot: tokens masked, still loading.
        authState.idToken = null;
        authState.isAuthenticated = false;
        authState.isLoading = true;
        rerender(shell('switching'));

        // The seed survives; the next reload on a worker page paints the name, not "W".
        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();

        authState.idToken = 'token-1';
        authState.isAuthenticated = true;
        authState.isLoading = false;
        rerender(shell('back'));
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());
        expect(apiFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the cache on a route whose role is not signed in', async () => {
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());

        // A worker-only browser opening /employer/dashboard: the restore
        // SETTLES with no session at all -- `isLoading` false, and nothing
        // masked. That is not a sign-out either, and the worker's chip has to
        // survive it, or coming back paints the bare letter again.
        authState.idToken = null;
        authState.isAuthenticated = false;
        authState.isLoading = false;
        rerender(shell('employer route'));

        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();

        authState.idToken = 'token-1';
        authState.isAuthenticated = true;
        rerender(shell('back on a worker page'));
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());
        expect(apiFetch).toHaveBeenCalledTimes(1);
    });

    it('drops only the signed-out role when the other one is still in', async () => {
        sessionStorage.setItem(
            'jale.sidebar_chip.employer',
            JSON.stringify({ name: 'Acme', meta: null, initials: 'A', locale: 'en' }),
        );
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());

        authState.sessionCleared = { epoch: 1, role: 'employer' };
        rerender(shell('employer signed out'));

        await waitFor(() => expect(sessionStorage.getItem('jale.sidebar_chip.employer')).toBeNull());
        // The worker in this very tab did not sign out.
        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();
        expect(screen.getByText('David Ramos')).toBeInTheDocument();
    });

    it('drops the cache when the session ends', async () => {
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());
        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();

        // The EXPLICIT signal, which only `AuthContext.clearSession` sends.
        authState.idToken = null;
        authState.isAuthenticated = false;
        authState.sessionCleared = { epoch: 1, role: 'worker' };
        rerender(shell('signed out'));

        await waitFor(() => expect(sessionStorage.getItem(CHIP_KEY)).toBeNull());
        expect(screen.queryByText('David Ramos')).not.toBeInTheDocument();
        // Loading, not failed: the chip makes no claim about an account that
        // is no longer signed in.
        expect(screen.queryByText('W')).not.toBeInTheDocument();
    });
});
