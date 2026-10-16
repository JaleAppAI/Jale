// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

/*
 * F27. The worker nav had no attention source: an employer asking for details,
 * or a hire nobody had acknowledged, showed nowhere until the worker happened
 * to open the home page. Applications now carries the count, on both rails.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
}));

const authState = {
    idToken: 'token-1' as string | null,
    isAuthenticated: true,
    isLoading: false,
    userType: 'worker' as const,
    sessionCleared: { epoch: 0, role: null as 'worker' | 'employer' | null },
    logout: vi.fn(),
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const attention = { count: 0 };
vi.mock('@/contexts/WorkerAttentionContext', () => ({ useWorkerAttentionCount: () => attention.count }));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { SidebarProfileProvider } from '@/contexts/SidebarProfileContext';
import { AppShell } from '../AppShell';
import { Sidebar } from '../Sidebar';
import { BottomTabBar } from '../BottomTabBar';

const chip = { status: 'loaded', name: 'Prueba Worker', meta: null, initials: 'PW' } as const;

/** The ICU plural, spelled out the way `unread-badge.test.tsx` does it. */
function attentionLabel(count: number, locale: 'en' | 'es' = 'en'): string {
    const raw = message('app_shell.applications_attention_badge', locale);
    const form = count === 1 ? /one \{([^}]*)\}/ : /other \{([^}]*)\}/;
    return interpolate((raw.match(form)?.[1] ?? '').replace(/#/g, '{count}'), { count });
}

const applicationsLink = () =>
    screen.getAllByRole('link', { name: new RegExp(message('header.my_applications')) })[0];

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    attention.count = 0;
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ full_name: 'Prueba Worker' }) });
});

describe('the worker Applications badge', () => {
    it('shows the count on Applications and names it for a screen reader', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={chip} attentionCount={2} />);

        const link = applicationsLink();
        expect(link.textContent).toContain('2');
        expect(within(link).getByText(attentionLabel(2))).toBeInTheDocument();
    });

    it('puts it on Applications and nowhere else', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={chip} attentionCount={2} />);

        for (const key of ['header.worker_home', 'header.profile']) {
            const other = screen.getByRole('link', { name: new RegExp(message(key)) });
            expect(other.textContent).not.toContain('2');
        }
    });

    it('renders no pill at zero', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={chip} attentionCount={0} />);
        expect(screen.queryByText(attentionLabel(1))).not.toBeInTheDocument();
        expect(applicationsLink().textContent).not.toMatch(/\d/);
    });

    it('shows on the mobile tab bar too, in Spanish', () => {
        renderIntl(<BottomTabBar role="worker" attentionCount={1} />, 'es');
        const link = screen.getByRole('link', { name: new RegExp(message('header.my_applications', 'es')) });
        expect(within(link).getByText(attentionLabel(1, 'es'))).toBeInTheDocument();
    });

    it('never badges the employer nav with it', () => {
        renderIntl(<Sidebar role="employer" homeHref="/employer/dashboard" chip={chip} attentionCount={5} />);
        expect(screen.queryByText('5')).not.toBeInTheDocument();
    });

    it('is fed by AppShell from the attention context', async () => {
        attention.count = 3;
        renderIntl(
            <SidebarProfileProvider>
                <AppShell role="worker" title="Page">page</AppShell>
            </SidebarProfileProvider>,
        );
        await waitFor(() => expect(screen.getAllByText(attentionLabel(3)).length).toBeGreaterThanOrEqual(1));
    });
});
