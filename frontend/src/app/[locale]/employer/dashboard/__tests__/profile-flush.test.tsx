// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import type { EmployerBilling, Job } from '@/lib/api/employer';

/*
 * A new employer now lands on the dashboard after sign-up, not on Profile. The
 * sign-up form's answers (company, phone, city, trades, signup source) wait in
 * sessionStorage until something PATCHes them, and only the profile page used
 * to. The dashboard sends them on load, so nobody has to open Profile first.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token', userType: 'employer', isAuthenticated: true }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/components/employer/PostJobModal', () => ({
    PostJobModal: () => null,
}));

const updateEmployerProfile = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: vi.fn(),
    getBilling: vi.fn(),
    listJobTemplates: vi.fn(),
    updateEmployerProfile: (...args: unknown[]) => updateEmployerProfile(...args),
}));

vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        items: [], unreadCount: 0, unreadByConversation: {}, loading: false, errorKind: null,
        retry: vi.fn(), refresh: vi.fn(), markRead: vi.fn(),
    }),
    useUnreadCount: () => 0,
}));

type DashboardData = { jobs: Job[]; billing: EmployerBilling | null; templateCount: number | null };
const seed: DashboardData = { jobs: [], billing: null, templateCount: 0 };

vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const [data] = react.useState<DashboardData>(() => seed);
            return {
                phase: 'ready' as const, data, empty: data.jobs.length === 0, errorKind: null,
                refreshing: false, refreshError: null, retry: vi.fn(), refresh: vi.fn(), setData: vi.fn(),
            };
        },
    };
});

import { renderIntl } from '@/components/employer/__tests__/render-intl';
import { PostJobProvider } from '@/contexts/PostJobContext';
import EmployerDashboardPage from '../page';

const PENDING = { company_name: 'Test Builders', hiring_trades: ['concrete'] };

function renderDashboard() {
    return renderIntl(
        <PostJobProvider>
            <EmployerDashboardPage />
        </PostJobProvider>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
});

describe('dashboard: the pending sign-up answers', () => {
    it('saves them once on load and clears the store', async () => {
        sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
        updateEmployerProfile.mockResolvedValue({ id: 'e1' });

        renderDashboard();

        await waitFor(() => expect(sessionStorage.getItem('pendingEmployerProfile')).toBeNull());
        expect(updateEmployerProfile).toHaveBeenCalledTimes(1);
        expect(updateEmployerProfile).toHaveBeenCalledWith('test-token', PENDING);
    });

    it('keeps them for a retry when the save fails, and the board still renders', async () => {
        sessionStorage.setItem('pendingEmployerProfile', JSON.stringify(PENDING));
        updateEmployerProfile.mockRejectedValue(new Error('offline'));

        const { container } = renderDashboard();

        await waitFor(() => expect(updateEmployerProfile).toHaveBeenCalledTimes(1));
        expect(sessionStorage.getItem('pendingEmployerProfile')).toBe(JSON.stringify(PENDING));
        expect(container.textContent).not.toBe('');
    });

    it('sends nothing on an ordinary visit', async () => {
        renderDashboard();
        await Promise.resolve();
        expect(updateEmployerProfile).not.toHaveBeenCalled();
    });
});
