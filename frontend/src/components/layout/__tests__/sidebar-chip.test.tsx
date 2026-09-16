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
const authState = { idToken: 'token-1' as string | null, isAuthenticated: true, logout: vi.fn() };
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

    it('drops the cache when the session ends', async () => {
        const { rerender } = renderIntl(shell());
        await waitFor(() => expect(screen.getByText('David Ramos')).toBeInTheDocument());
        expect(sessionStorage.getItem(CHIP_KEY)).not.toBeNull();

        authState.idToken = null;
        authState.isAuthenticated = false;
        rerender(shell('signed out'));

        await waitFor(() => expect(sessionStorage.getItem(CHIP_KEY)).toBeNull());
        expect(screen.queryByText('David Ramos')).not.toBeInTheDocument();
        // Loading, not failed: the chip makes no claim about an account that
        // is no longer signed in.
        expect(screen.queryByText('W')).not.toBeInTheDocument();
    });
});
