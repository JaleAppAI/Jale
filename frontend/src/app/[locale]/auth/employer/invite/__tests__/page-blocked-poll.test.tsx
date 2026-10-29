// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { act, cleanup, screen, waitFor } from '@testing-library/react';

/**
 * Milestone C review, C1: the root layout's inbox poll must not bounce a
 * blocked login off the invite page.
 *
 * A removed foreman who was re-invited (or an orgless login whose owner
 * resent the invite) opens the invite link while signed in. The page offers
 * one-click Join. Before the fix, the global `UnreadMessagesProvider` polled
 * `GET /employer/inbox`, got 403 `membership_inactive`, and `usePageData`
 * handed that to `useRequireAuth.handleLegalWall`, which replaced the route
 * with `/employer/access` before Join could be pressed.
 *
 * The page is rendered inside the REAL provider, with the REAL `usePageData`
 * and `useRequireAuth` -- the per-task suites mock those, which is why none
 * of them caught this. Only the routers, the session and the network are
 * doubles.
 */

const { i18nReplace, i18nPush, nextReplace, notFound, getInbox, team } = vi.hoisted(() => ({
    i18nReplace: vi.fn(),
    i18nPush: vi.fn(),
    nextReplace: vi.fn(),
    notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
    getInbox: vi.fn(),
    team: {
        lookupInvite: vi.fn(),
        acceptInvite: vi.fn(),
        getMembership: vi.fn(),
    },
}));

vi.mock('next/navigation', () => ({
    notFound,
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ replace: nextReplace, push: vi.fn() }),
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace: i18nReplace, push: i18nPush }),
    // next-intl's pathname: locale-free.
    usePathname: () => '/auth/employer/invite',
    Link: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({
        idToken: 'employer-token',
        isAuthenticated: true,
        isLoading: false,
        userType: 'employer',
        sessionCleared: { epoch: 0, role: null },
        setTokens: vi.fn(),
        getValidIdTokenOrNull: vi.fn().mockResolvedValue('employer-token'),
    }),
}));
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getInbox: (...args: unknown[]) => getInbox(...args),
}));
vi.mock('@/lib/api/team', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/team')>()),
    ...team,
}));
vi.mock('@/lib/cognito', () => ({}));
vi.mock('@/lib/location-search', () => ({ queryLocations: vi.fn().mockResolvedValue([]) }));
vi.mock('@/components/auth/AuthShell', () => ({
    AuthShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { INBOX_POLL_MS, UnreadMessagesProvider } from '@/contexts/UnreadMessagesContext';
import { MembershipBlockedError } from '@/lib/api';
import EmployerInvitePage from '../page';

const LOOKUP_EXISTING = {
    companyName: 'Acme Builders',
    email: 'ana@example.com',
    contactName: 'Ana Ruiz',
    existingAccount: true,
    expiresAt: '2026-11-03T00:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    window.history.replaceState(null, '', '/en/auth/employer/invite?token=tok-1');
    team.lookupInvite.mockResolvedValue(LOOKUP_EXISTING);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
});

describe('invite page inside the global inbox poll (C1)', () => {
    it.each([
        ['removed, re-invited', new MembershipBlockedError('removed', true)],
        ['orgless, invite resent', new MembershipBlockedError('no_organization')],
    ])('%s: a blocked inbox answer does not navigate, and Join stays pressable', async (_label, blocked) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        getInbox.mockRejectedValue(blocked);

        renderIntl(
            <UnreadMessagesProvider>
                <EmployerInvitePage />
            </UnreadMessagesProvider>,
        );

        const join = await screen.findByRole('button', {
            name: interpolate(message('auth.employer.invite.join_submit'), { companyName: 'Acme Builders' }),
        });
        await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(1));

        // Several poll intervals later: still here, still one inbox read.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(INBOX_POLL_MS * 3);
        });

        expect(i18nReplace).not.toHaveBeenCalled();
        expect(i18nPush).not.toHaveBeenCalled();
        expect(nextReplace).not.toHaveBeenCalled();
        expect(getInbox).toHaveBeenCalledTimes(1);
        expect(join).toBeEnabled();
        expect(join).toBeInTheDocument();
    });
});
