// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { formatLongDate } from '@/lib/date';
import { PendingInvitesList } from '../PendingInvitesList';
import type { TeamActionResult } from '../types';
import { INVITE_EXPIRED, INVITE_LIVE } from './fixtures';

const RESEND = message('employer_team.pending.resend');
const REVOKE = message('employer_team.pending.revoke');

function rowFor(email: string): HTMLElement {
    return screen.getByText(email).closest('li') as HTMLElement;
}

async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
    vi.useRealTimers();
});

describe('PendingInvitesList', () => {
    it('shows each invite\'s email, contact name, and expires date or expired', () => {
        renderIntl(
            <PendingInvitesList invites={[INVITE_LIVE, INVITE_EXPIRED]} onResend={vi.fn()} onRevoke={vi.fn()} />,
        );
        const live = rowFor(INVITE_LIVE.email);
        expect(within(live).getByText('Dana Díaz')).toBeInTheDocument();
        expect(
            within(live).getByText(
                interpolate(message('employer_team.pending.expires'), { date: formatLongDate(INVITE_LIVE.expiresAt, 'en')! }),
            ),
        ).toBeInTheDocument();
        const old = rowFor(INVITE_EXPIRED.email);
        expect(within(old).getByText(message('employer_team.pending.expired'))).toBeInTheDocument();
        expect(within(old).queryByText(/Expires/)).toBeNull();
    });

    it('no invites: the empty line', () => {
        renderIntl(<PendingInvitesList invites={[]} onResend={vi.fn()} onRevoke={vi.fn()} />);
        expect(screen.getByText(message('employer_team.pending.empty'))).toBeInTheDocument();
    });

    it('resend rate-limited disables Resend for retry_after_seconds and shows the error', async () => {
        vi.useFakeTimers();
        const onResend = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({
            ok: false,
            message: 'Too many invites right now.',
            retryAfterSeconds: 30,
        });
        renderIntl(<PendingInvitesList invites={[INVITE_LIVE, INVITE_EXPIRED]} onResend={onResend} onRevoke={vi.fn()} />);
        const live = rowFor(INVITE_LIVE.email);
        fireEvent.click(within(live).getByRole('button', { name: RESEND }));
        await flush();

        expect(onResend).toHaveBeenCalledWith(INVITE_LIVE);
        expect(screen.getByRole('alert')).toHaveTextContent('Too many invites right now.');
        const resend = within(live).getByRole('button', { name: RESEND });
        expect(resend).toBeDisabled();
        expect(resend).toHaveAccessibleDescription(expect.stringContaining('Too many invites right now.'));
        // Only that row cools down.
        expect(within(rowFor(INVITE_EXPIRED.email)).getByRole('button', { name: RESEND })).toBeEnabled();

        act(() => { vi.advanceTimersByTime(29_000); });
        expect(within(live).getByRole('button', { name: RESEND })).toBeDisabled();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(within(live).getByRole('button', { name: RESEND })).toBeEnabled();
    });

    it('Resend waits 60 s after lastSentAt, with a visible "Try again in Ns", and the wait is derived from the data', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
        const justSent = { ...INVITE_LIVE, lastSentAt: '2026-10-27T11:59:45.000Z' };
        const { rerender } = renderIntl(
            <PendingInvitesList invites={[justSent, INVITE_EXPIRED]} onResend={vi.fn()} onRevoke={vi.fn()} />,
        );
        const live = () => rowFor(INVITE_LIVE.email);
        expect(within(live()).getByRole('button', { name: RESEND })).toBeDisabled();
        expect(within(live()).getByText('Try again in 45s.')).toBeInTheDocument();
        expect(within(live()).getByRole('button', { name: RESEND })).toHaveAccessibleDescription(
            expect.stringContaining('Try again in 45s.'),
        );
        // Revoke is never held back, and an old invite can be resent.
        expect(within(live()).getByRole('button', { name: REVOKE })).toBeEnabled();
        expect(within(rowFor(INVITE_EXPIRED.email)).getByRole('button', { name: RESEND })).toBeEnabled();

        act(() => { vi.advanceTimersByTime(15_000); });
        expect(within(live()).getByText('Try again in 30s.')).toBeInTheDocument();

        // A refetch carrying a newer lastSentAt (a resend from elsewhere) restarts the wait.
        rerender(
            <PendingInvitesList
                invites={[{ ...justSent, lastSentAt: '2026-10-27T12:00:15.000Z' }, INVITE_EXPIRED]}
                onResend={vi.fn()}
                onRevoke={vi.fn()}
            />,
        );
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(within(live()).getByText('Try again in 59s.')).toBeInTheDocument();
        act(() => { vi.advanceTimersByTime(59_000); });
        expect(within(live()).getByRole('button', { name: RESEND })).toBeEnabled();
        expect(within(live()).queryByText(/Try again in/)).toBeNull();
    });

    it('a failure without a wait leaves Resend enabled', async () => {
        const onResend = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: false, message: 'Busy.' });
        renderIntl(<PendingInvitesList invites={[INVITE_LIVE]} onResend={onResend} onRevoke={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: RESEND }));
        await flush();
        expect(screen.getByRole('alert')).toHaveTextContent('Busy.');
        expect(screen.getByRole('button', { name: RESEND })).toBeEnabled();
    });

    it('Revoke hands the invite to onRevoke; both buttons are disabled while it runs', async () => {
        let resolve!: (r: TeamActionResult) => void;
        const onRevoke = vi.fn(() => new Promise<TeamActionResult>((r) => { resolve = r; }));
        renderIntl(<PendingInvitesList invites={[INVITE_LIVE]} onResend={vi.fn()} onRevoke={onRevoke} />);
        fireEvent.click(screen.getByRole('button', { name: REVOKE }));
        expect(onRevoke).toHaveBeenCalledWith(INVITE_LIVE);
        expect(screen.getByRole('button', { name: REVOKE })).toBeDisabled();
        expect(screen.getByRole('button', { name: RESEND })).toBeDisabled();
        await act(async () => { resolve({ ok: true }); });
        expect(screen.getByRole('button', { name: REVOKE })).toBeEnabled();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('a routed failure (message null) shows nothing', async () => {
        const onRevoke = vi.fn<() => Promise<TeamActionResult>>().mockResolvedValue({ ok: false, message: null });
        renderIntl(<PendingInvitesList invites={[INVITE_LIVE]} onResend={vi.fn()} onRevoke={onRevoke} />);
        fireEvent.click(screen.getByRole('button', { name: REVOKE }));
        await flush();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
