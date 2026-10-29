// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/lib/api/errors';
import { MembershipBlockedError } from '@/lib/api';
import type { EmployerMembership } from '@/hooks/useEmployerMembership';
import type { TeamList } from '@/lib/api/team';

const state = vi.hoisted(() => ({
    membership: { status: 'loading' } as EmployerMembership,
}));

const { replace, notFound, handleLegalWall, getTeam, createInvite, resendInvite, revokeInvite, removeMember } = vi.hoisted(() => ({
    replace: vi.fn(),
    notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
    // Routes nothing: every error reaches the page, as for a non-wall error.
    handleLegalWall: vi.fn((err: unknown): void => { throw err; }),
    getTeam: vi.fn(),
    createInvite: vi.fn(),
    resendInvite: vi.fn(),
    revokeInvite: vi.fn(),
    removeMember: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound }));
const router = vi.hoisted(() => ({ current: null as null | { replace: (href: string) => void } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
    usePathname: () => '/employer/team',
    useRouter: () => (router.current ??= { replace: (href: string) => replace(href) }),
}));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ idToken: 'tok', isAuthenticated: true, isLoading: false, handleLegalWall }),
}));
vi.mock('@/hooks/useEmployerMembership', () => ({ useEmployerMembership: () => state.membership }));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/employer/PostJobButton', () => ({ PostJobButton: () => null }));
vi.mock('@/lib/api/team', async () => ({
    ...(await vi.importActual<typeof import('@/lib/api/team')>('@/lib/api/team')),
    getTeam,
    createInvite,
    resendInvite,
    revokeInvite,
    removeMember,
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ToastProvider } from '@/components/ui/toast';
import { ANA, BETO, CARLA, DIEGO, INVITE_LIVE, OWNER, teamList } from '@/components/employer/team/__tests__/fixtures';
import EmployerTeamPage from '../page';

const OWNER_MEMBERSHIP: EmployerMembership = {
    status: 'ready',
    role: 'owner',
    companyName: 'Acme',
    userId: OWNER.userId,
    organizationId: 'org-1',
};

function renderPage(locale: 'en' | 'es' = 'en') {
    return renderIntl(
        <ToastProvider>
            <EmployerTeamPage />
        </ToastProvider>,
        locale,
    );
}

async function loaded(list: TeamList = teamList()) {
    getTeam.mockResolvedValue(list);
    renderPage();
    await screen.findByText(message('employer_team.members.title'));
}

/**
 * A mutation's state update lands after an await, outside act, so React
 * leaves its passive effects (the cool-down ticker) to the scheduler. Flush
 * them before driving the fake clock.
 */
async function flushEffects() {
    await act(async () => { await Promise.resolve(); });
}

function rowOf(text: string): HTMLElement {
    return screen.getByText(text).closest('li') as HTMLElement;
}

beforeEach(() => {
    vi.clearAllMocks();
    handleLegalWall.mockImplementation((err: unknown): void => { throw err; });
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    state.membership = OWNER_MEMBERSHIP;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('employer team page', () => {
    it('flag off: not found', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        expect(() => renderPage()).toThrow('NEXT_NOT_FOUND');
        expect(notFound).toHaveBeenCalled();
        expect(getTeam).not.toHaveBeenCalled();
    });

    it('foreman: redirected', async () => {
        state.membership = { ...OWNER_MEMBERSHIP, role: 'foreman' };
        renderPage();
        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(getTeam).not.toHaveBeenCalled();
        expect(screen.queryByText(message('employer_team.members.title'))).toBeNull();
    });

    it('foreman by the billing fallback (membership error): redirected', async () => {
        state.membership = { status: 'error', billingRole: 'foreman' };
        renderPage();
        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(getTeam).not.toHaveBeenCalled();
    });

    it('membership error with an owner billing role loads the team', async () => {
        state.membership = { status: 'error', billingRole: 'owner' };
        await loaded();
        expect(replace).not.toHaveBeenCalled();
    });

    it('membership error with no billing role: the server decides (loads; a 403 shows the error state)', async () => {
        state.membership = { status: 'error', billingRole: null };
        await loaded();
        expect(replace).not.toHaveBeenCalled();
        // "You" needs the membership's userId, which an error does not carry.
        expect(screen.queryByText(message('employer_team.members.you'))).toBeNull();
        cleanup();

        getTeam.mockReset();
        getTeam.mockRejectedValueOnce(new ApiError(403, 'owner_required'));
        renderPage();
        expect(await screen.findByText(message('common.errors.forbidden'))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it('loading or blocked membership: a skeleton and no request', () => {
        for (const membership of [
            { status: 'loading' },
            { status: 'blocked', reason: 'removed', hasInvite: false },
        ] as EmployerMembership[]) {
            state.membership = membership;
            const view = renderPage();
            expect(getTeam).not.toHaveBeenCalled();
            expect(replace).not.toHaveBeenCalled();
            expect(screen.queryByText(message('employer_team.members.title'))).toBeNull();
            view.unmount();
        }
    });

    it('shows used = active + pending of limit and the pending count', async () => {
        await loaded(teamList({ seats: { limit: 5, active: 2, pending: 1, suspended: 1 } }));
        expect(screen.getByText(interpolate(message('employer_team.seats'), { used: 3, limit: 5 }))).toBeInTheDocument();
        expect(screen.getByText('1 pending invite')).toBeInTheDocument();
        expect(getTeam).toHaveBeenCalledWith('tok', expect.any(AbortSignal));
    });

    it('no pending invites: no pending count', async () => {
        await loaded(teamList({ seats: { limit: 5, active: 2, pending: 0, suspended: 0 }, invites: [] }));
        expect(screen.getByText(interpolate(message('employer_team.seats'), { used: 2, limit: 5 }))).toBeInTheDocument();
        expect(screen.queryByText(/^\d+ pending invites?$/)).toBeNull();
    });

    it('limit 0: the upgrade message and no invite form', async () => {
        await loaded(teamList({ seats: { limit: 0, active: 0, pending: 0, suspended: 1 }, members: [OWNER, CARLA], invites: [] }));
        expect(screen.getByText(message('employer_team.no_seats'))).toBeInTheDocument();
        expect(screen.getByRole('link', { name: message('employer_team.no_seats_link') })).toHaveAttribute('href', '/employer/billing');
        expect(screen.queryByLabelText(message('employer_team.invite.email'))).toBeNull();
        expect(screen.queryByRole('button', { name: message('employer_team.invite.submit') })).toBeNull();
        // Members stay manageable: a suspended foreman can still be removed.
        expect(within(rowOf(CARLA.name)).getByRole('button', { name: message('employer_team.members.remove') })).toBeInTheDocument();
    });

    it('invite success refetches and toasts; email_in_use shows its message', async () => {
        await loaded();
        createInvite.mockResolvedValueOnce({ invite: INVITE_LIVE, accessUpdated: true });
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'new@example.com' } });
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.name')), { target: { value: 'Nico' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));

        expect(await screen.findByText(interpolate(message('employer_team.invite.sent'), { email: 'new@example.com' }))).toBeInTheDocument();
        expect(createInvite).toHaveBeenCalledWith('tok', { email: 'new@example.com', contactName: 'Nico', locale: 'en' });
        await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));

        createInvite.mockRejectedValueOnce(new ApiError(409, 'email_in_use'));
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'taken@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
        expect(await screen.findByText(message('employer_team.errors.email_in_use'))).toBeInTheDocument();
        expect(screen.getByLabelText(message('employer_team.invite.email'))).toHaveAccessibleDescription(
            message('employer_team.errors.email_in_use'),
        );
    });

    it('invite sends the page locale', async () => {
        getTeam.mockResolvedValue(teamList());
        renderPage('es');
        await screen.findByText(message('employer_team.members.title', 'es'));
        createInvite.mockResolvedValueOnce({ invite: INVITE_LIVE, accessUpdated: true });
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email', 'es')), { target: { value: 'n@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit', 'es') }));
        await waitFor(() => expect(createInvite).toHaveBeenCalledWith('tok', { email: 'n@example.com', locale: 'es' }));
    });

    it('seat_limit_reached shows the owner seat copy with the remove-or-revoke remedy (no change plan) and refetches', async () => {
        await loaded();
        createInvite.mockRejectedValueOnce(new ApiError(403, 'seat_limit_reached'));
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'x@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
        const text = `${message('employer_team.errors.seat_limit_reached')} ${message('employer_team.invite.seats_remedy')}`;
        expect(await screen.findByText(text)).toBeInTheDocument();
        expect(text).not.toMatch(/plan/i);
        await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('link', { name: message('employer_team.no_seats_link') })).toBeNull();
    });

    it('at the limit (used >= limit > 0): Send is disabled with the remove-or-revoke remedy', async () => {
        await loaded(teamList({ seats: { limit: 3, active: 2, pending: 1, suspended: 0 } }));
        expect(screen.getByText(interpolate(message('employer_team.seats'), { used: 3, limit: 3 }))).toBeInTheDocument();
        expect(screen.getByText(message('employer_team.invite.seats_full'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('employer_team.invite.submit') })).toBeDisabled();
        expect(screen.queryByRole('link', { name: message('employer_team.no_seats_link') })).toBeNull();
    });

    it('below the limit: no seats-full notice', async () => {
        await loaded(teamList({ seats: { limit: 3, active: 1, pending: 1, suspended: 0 } }));
        expect(screen.queryByText(message('employer_team.invite.seats_full'))).toBeNull();
        expect(screen.getByRole('button', { name: message('employer_team.invite.submit') })).toBeEnabled();
    });

    it('invite rate-limited: Send is disabled (60 s when no wait is named)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await loaded();
        createInvite.mockRejectedValueOnce(new ApiError(429, 'invite_rate_limited'));
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'x@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
        expect(await screen.findByText(message('employer_team.errors.invite_rate_limited'))).toBeInTheDocument();
        await flushEffects();
        const send = () => screen.getByRole('button', { name: message('employer_team.invite.submit') });
        expect(send()).toBeDisabled();
        act(() => { vi.advanceTimersByTime(59_000); });
        expect(send()).toBeDisabled();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(send()).toBeEnabled();
    });

    it('busy (after the client\'s one retry) shows the busy copy', async () => {
        await loaded();
        createInvite.mockRejectedValueOnce(new ApiError(503, 'busy'));
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'x@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
        expect(await screen.findByText(message('employer_team.errors.busy'))).toBeInTheDocument();
    });

    it('resend success toasts and refetches', async () => {
        await loaded();
        resendInvite.mockResolvedValueOnce({ invite: INVITE_LIVE, accessUpdated: true });
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.resend') }));
        expect(await screen.findByText(interpolate(message('employer_team.pending.resent'), { email: INVITE_LIVE.email }))).toBeInTheDocument();
        expect(resendInvite).toHaveBeenCalledWith('tok', INVITE_LIVE.inviteId, 'en');
        await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
    });

    it('resend rate-limited disables Resend for retry_after_seconds, 60 s without it', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await loaded();
        const resendButton = () => within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.resend') });

        // The backend's camelCase wait.
        resendInvite.mockRejectedValueOnce(new ApiError(429, 'invite_rate_limited', { retryAfterSeconds: 20 }));
        fireEvent.click(resendButton());
        expect(await screen.findByText(message('employer_team.errors.invite_rate_limited'))).toBeInTheDocument();
        await flushEffects();
        expect(resendButton()).toBeDisabled();
        act(() => { vi.advanceTimersByTime(19_000); });
        expect(resendButton()).toBeDisabled();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(resendButton()).toBeEnabled();

        // No wait named: 60 s.
        resendInvite.mockRejectedValueOnce(new ApiError(429, 'invite_rate_limited'));
        fireEvent.click(resendButton());
        await waitFor(() => expect(resendButton()).toBeDisabled());
        await flushEffects();
        act(() => { vi.advanceTimersByTime(59_000); });
        expect(resendButton()).toBeDisabled();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(resendButton()).toBeEnabled();
    });

    it('revoke removes the row after refetch', async () => {
        getTeam
            .mockResolvedValueOnce(teamList())
            .mockResolvedValueOnce(teamList({ invites: [], seats: { limit: 5, active: 2, pending: 0, suspended: 1 } }));
        renderPage();
        await screen.findByText(INVITE_LIVE.email);
        revokeInvite.mockResolvedValueOnce({ revoked: true, accessUpdated: true });
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.revoke') }));
        await waitFor(() => expect(screen.queryByText(INVITE_LIVE.email)).toBeNull());
        expect(revokeInvite).toHaveBeenCalledWith('tok', INVITE_LIVE.inviteId);
        expect(screen.getByText(message('employer_team.pending.revoked'))).toBeInTheDocument();
        expect(screen.getByText(message('employer_team.pending.empty'))).toBeInTheDocument();
    });

    it('invite_closed on resend refetches and is not shown as an error', async () => {
        getTeam.mockResolvedValueOnce(teamList()).mockResolvedValueOnce(teamList({ invites: [] }));
        renderPage();
        await screen.findByText(INVITE_LIVE.email);
        resendInvite.mockRejectedValueOnce(new ApiError(409, 'invite_closed'));
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.resend') }));
        await waitFor(() => expect(screen.queryByText(INVITE_LIVE.email)).toBeNull());
        expect(getTeam).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText(message('employer_team.errors.invite_closed'))).toBeInTheDocument();
    });

    it('a 404 not_found (the route, not a row) shows the generic copy and does not refetch', async () => {
        await loaded();
        revokeInvite.mockRejectedValueOnce(new ApiError(404, 'not_found'));
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.revoke') }));
        expect(await screen.findByText(message('employer_team.errors.generic'))).toBeInTheDocument();
        expect(getTeam).toHaveBeenCalledTimes(1);
    });

    it('a legal wall or blocked login in a mutation is routed: no message, no refetch', async () => {
        await loaded();
        // handleLegalWall routes (returns) instead of rethrowing.
        handleLegalWall.mockImplementation(() => undefined);
        const blocked = new MembershipBlockedError('removed');
        revokeInvite.mockRejectedValueOnce(blocked);
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.revoke') }));
        await waitFor(() => expect(handleLegalWall).toHaveBeenCalledWith(blocked, '/employer/team'));
        await act(async () => { await Promise.resolve(); });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(getTeam).toHaveBeenCalledTimes(1);

        const wall = new ApiError(403, 'legal_required');
        createInvite.mockRejectedValueOnce(wall);
        fireEvent.change(screen.getByLabelText(message('employer_team.invite.email')), { target: { value: 'x@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_team.invite.submit') }));
        await waitFor(() => expect(handleLegalWall).toHaveBeenCalledWith(wall, '/employer/team'));
        await act(async () => { await Promise.resolve(); });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(getTeam).toHaveBeenCalledTimes(1);
    });

    it('a failed refetch after a mutation shows the footnote and keeps the lists', async () => {
        getTeam.mockResolvedValueOnce(teamList()).mockRejectedValueOnce(new ApiError(500, 'internal_error'));
        renderPage();
        await screen.findByText(INVITE_LIVE.email);
        revokeInvite.mockResolvedValueOnce({ revoked: true, accessUpdated: true });
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.revoke') }));
        expect(await screen.findByText(message('common.errors.server'))).toBeInTheDocument();
        expect(screen.getByText(INVITE_LIVE.email)).toBeInTheDocument();
    });

    it('invite_closed on revoke refetches and is not shown as an error', async () => {
        getTeam.mockResolvedValueOnce(teamList()).mockResolvedValueOnce(teamList({ invites: [] }));
        renderPage();
        await screen.findByText(INVITE_LIVE.email);
        revokeInvite.mockRejectedValueOnce(new ApiError(409, 'invite_closed'));
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.revoke') }));
        await waitFor(() => expect(screen.queryByText(INVITE_LIVE.email)).toBeNull());
        expect(getTeam).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('invite_not_found on resend refetches, then shows its message', async () => {
        getTeam.mockResolvedValueOnce(teamList()).mockResolvedValueOnce(teamList({ invites: [] }));
        renderPage();
        await screen.findByText(INVITE_LIVE.email);
        resendInvite.mockRejectedValueOnce(new ApiError(404, 'invite_not_found'));
        fireEvent.click(within(rowOf(INVITE_LIVE.email)).getByRole('button', { name: message('employer_team.pending.resend') }));
        expect(await screen.findByText(message('employer_team.errors.invite_not_found'))).toBeInTheDocument();
        expect(getTeam).toHaveBeenCalledTimes(2);
    });

    it('remove dialog: the picker excludes the target and suspended members and defaults to the owner; confirm sends reassignTo', async () => {
        await loaded();
        fireEvent.click(within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') }));
        const dialog = await screen.findByRole('dialog');
        const picker = within(dialog).getByLabelText(message('employer_team.remove.reassign_label')) as HTMLSelectElement;
        // Not Ana (the target), Carla (suspended) or Diego (billing-suspended).
        expect(Array.from(picker.options).map((o) => o.value)).toEqual([OWNER.userId, BETO.userId]);
        expect(Array.from(picker.options).map((o) => o.value)).not.toContain(DIEGO.userId);
        expect(picker.value).toBe(OWNER.userId);
        fireEvent.change(picker, { target: { value: BETO.userId } });

        let resolve!: (v: unknown) => void;
        removeMember.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(removeMember).toHaveBeenCalledWith('tok', ANA.userId, BETO.userId);
        // Disabled while the request is pending.
        expect(picker).toBeDisabled();

        await act(async () => { resolve({ removed: true, movedJobs: 2, accessUpdated: true }); });
        expect(await screen.findByText(`${ANA.name} was removed. 2 jobs moved.`)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
        expect(screen.queryByText(/couldn't disable their login/)).toBeNull();
    });

    it('after a removal and its refetch, focus moves to the members list, not the body', async () => {
        getTeam
            .mockResolvedValueOnce(teamList())
            .mockResolvedValueOnce(teamList({ members: [OWNER, BETO, CARLA, DIEGO] }));
        renderPage();
        await screen.findByText(ANA.name);
        const remove = within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') });
        remove.focus();
        fireEvent.click(remove);
        const dialog = await screen.findByRole('dialog');
        removeMember.mockResolvedValueOnce({ removed: true, movedJobs: 2, accessUpdated: true });
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
        await waitFor(() => expect(screen.queryByText(ANA.name)).toBeNull());
        const list = screen.getByRole('list', { name: message('employer_team.members.title') });
        await waitFor(() => expect(document.activeElement).toBe(list));
    });

    it('accessUpdated false: a warning that the login could not be disabled yet and will be retried', async () => {
        await loaded();
        fireEvent.click(within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') }));
        const dialog = await screen.findByRole('dialog');
        removeMember.mockResolvedValueOnce({ removed: true, movedJobs: 0, accessUpdated: false });
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
        const warning = interpolate(message('employer_team.remove.access_pending'), { name: ANA.name });
        expect(await screen.findByText(warning)).toBeInTheDocument();
        expect(warning).toMatch(/retry automatically/);
    });

    it.each(['member_not_found', 'already_removed'] as const)(
        'remove refused with %s: when the refetch drops the member, the dialog closes and the message is a toast',
        async (code) => {
            getTeam
                .mockResolvedValueOnce(teamList())
                .mockResolvedValueOnce(teamList({ members: [OWNER, BETO, CARLA, DIEGO] }));
            renderPage();
            await screen.findByText(ANA.name);
            fireEvent.click(within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') }));
            const dialog = await screen.findByRole('dialog');
            removeMember.mockRejectedValueOnce(new ApiError(code === 'member_not_found' ? 404 : 409, code));
            fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            expect(screen.getByText(message(`employer_team.errors.${code}`))).toBeInTheDocument();
            expect(getTeam).toHaveBeenCalledTimes(2);
        },
    );

    it('remove refused with already_removed while the refetch still lists them: the dialog stays with the message', async () => {
        await loaded();
        fireEvent.click(within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') }));
        const dialog = await screen.findByRole('dialog');
        removeMember.mockRejectedValueOnce(new ApiError(409, 'already_removed'));
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(await within(dialog).findByText(message('employer_team.errors.already_removed'))).toBeInTheDocument();
        expect(getTeam).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('remove refused with invalid_assignee refetches and shows its message in the dialog', async () => {
        await loaded();
        fireEvent.click(within(rowOf(ANA.name)).getByRole('button', { name: message('employer_team.members.remove') }));
        const dialog = await screen.findByRole('dialog');
        removeMember.mockRejectedValueOnce(new ApiError(409, 'invalid_assignee'));
        fireEvent.click(within(dialog).getByRole('button', { name: message('employer_team.remove.confirm') }));
        expect(await within(dialog).findByText(message('employer_team.errors.invalid_assignee'))).toBeInTheDocument();
        expect(getTeam).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('no Remove button on the owner row', async () => {
        await loaded();
        expect(within(rowOf(OWNER.name)).queryByRole('button', { name: message('employer_team.members.remove') })).toBeNull();
        expect(within(rowOf(BETO.name)).getByRole('button', { name: message('employer_team.members.remove') })).toBeInTheDocument();
    });

    it('a failed load shows the error state with a retry', async () => {
        getTeam.mockRejectedValueOnce(new ApiError(500, 'internal_error'));
        renderPage();
        expect(await screen.findByRole('button', { name: message('common.retry') })).toBeInTheDocument();
    });
});
