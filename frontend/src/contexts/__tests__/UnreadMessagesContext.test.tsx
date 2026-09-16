// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * The employer's unread-message count, owned once for the whole session.
 *
 * Before this context there was no unread signal in the UI at all: the inbox
 * was fetched by the conversations PAGE (once, no poll) and the floating
 * drawer fetched a different endpoint, only while it was open. An employer
 * anywhere else in the app had no way to learn that a worker had written --
 * the reply window closes on its own, so "no way to learn" means missed hires.
 *
 * What these tests pin, in the order the bugs would appear:
 *  - the count comes from the server's `unread_count`, not a re-derivation;
 *  - marking a thread read is OPTIMISTIC and REVERSIBLE, because the badge is
 *    the thing the employer is looking at while the POST is in flight;
 *  - there is exactly ONE inbox request for however many consumers mount, and
 *    exactly one poll cadence -- two pollers is the failure mode a context
 *    like this exists to prevent;
 *  - a hidden tab does not poll, and a tab coming BACK does not wait out a
 *    whole tick before it tells the truth.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/employer/dashboard',
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

let authState: { idToken: string | null; isAuthenticated: boolean; userType: 'employer' | 'worker' | null } = {
    idToken: 'test-token',
    isAuthenticated: true,
    userType: 'employer',
};
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => authState,
}));

// `usePageData`'s auth gate, resolved. The real hook reads the ROLE's token
// out of `useRequireAuth`; the suites for pages that use `usePageData` stub it
// the same way rather than standing up a router.
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
        idToken: authState.idToken,
        isAuthenticated: authState.isAuthenticated,
        isLoading: false,
    }),
}));

const getInbox = vi.fn();
const markConversationRead = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getInbox: (...args: unknown[]) => getInbox(...args),
    markConversationRead: (...args: unknown[]) => markConversationRead(...args),
}));

// Below the mocks on purpose (they hoist).
import { UnreadMessagesProvider, useUnreadMessages } from '@/contexts/UnreadMessagesContext';
import type { EmployerInboxResponse, InboxItem } from '@/lib/api/employer';

function inboxItem(overrides: Partial<InboxItem> & { application_id: string }): InboxItem {
    return {
        worker_id: 'w-1',
        worker_name: 'Maria Garcia',
        job_id: 'job-1',
        job_title: 'Line Cook',
        job_city: 'Austin',
        job_state_region: 'TX',
        job_status: 'active',
        application_status: 'contacted',
        applied_at: '2026-09-10T00:00:00Z',
        conversation_id: null,
        conversation_status: null,
        last_message_at: null,
        last_worker_message_at: null,
        last_message_preview: null,
        tab: 'active',
        unread: false,
        ...overrides,
    };
}

function inbox(): EmployerInboxResponse {
    return {
        items: [
            inboxItem({
                application_id: 'app-1',
                conversation_id: 'conv-1',
                conversation_status: 'open',
                last_message_at: '2026-09-16T10:00:00Z',
                last_worker_message_at: '2026-09-16T10:00:00Z',
                last_message_preview: 'I can start Monday',
                unread: true,
            }),
            inboxItem({
                application_id: 'app-2',
                worker_id: 'w-2',
                worker_name: 'Jose Ruiz',
                conversation_id: 'conv-2',
                conversation_status: 'open',
                last_message_at: '2026-09-15T10:00:00Z',
                last_worker_message_at: '2026-09-15T10:00:00Z',
                last_message_preview: 'Thanks',
                unread: true,
            }),
            inboxItem({
                application_id: 'app-3',
                worker_id: 'w-3',
                conversation_id: 'conv-3',
                conversation_status: 'closed',
                tab: 'closed',
                last_message_at: '2026-09-01T10:00:00Z',
                last_worker_message_at: '2026-09-01T10:00:00Z',
                unread: true,
            }),
        ],
        jobs: [{ job_id: 'job-1', title: 'Line Cook', city: 'Austin', status: 'active' }],
        unread_count: 3,
    };
}

function Probe({ label = 'probe' }: { label?: string }) {
    const { unreadCount, unreadByConversation, markRead } = useUnreadMessages();
    return (
        <div>
            <span data-testid={`${label}-count`}>{unreadCount}</span>
            <span data-testid={`${label}-conv-1`}>{String(Boolean(unreadByConversation['conv-1']))}</span>
            <button type="button" onClick={() => markRead('conv-1')}>mark conv-1</button>
            <button type="button" onClick={() => markRead('conv-3')}>mark conv-3</button>
        </div>
    );
}

function renderProvider(children: ReactNode) {
    return render(<UnreadMessagesProvider>{children}</UnreadMessagesProvider>);
}

/** The count, once the first inbox read has landed. */
async function countSettled(label = 'probe'): Promise<string> {
    await waitFor(() => expect(screen.getByTestId(`${label}-count`).textContent).not.toBe('0'));
    return screen.getByTestId(`${label}-count`).textContent ?? '';
}

beforeEach(() => {
    authState = { idToken: 'test-token', isAuthenticated: true, userType: 'employer' };
    getInbox.mockReset();
    markConversationRead.mockReset();
    getInbox.mockResolvedValue(inbox());
    markConversationRead.mockResolvedValue({
        conversation_id: 'conv-1',
        employer_last_read_at: '2026-09-16T11:00:00Z',
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('UnreadMessagesProvider', () => {
    it('publishes the count the server sent, not one it re-derived', async () => {
        renderProvider(<Probe />);

        expect(await countSettled()).toBe('3');
        expect(screen.getByTestId('probe-conv-1').textContent).toBe('true');
    });

    it('runs one inbox request however many consumers mount', async () => {
        renderProvider(
            <>
                <Probe label="a" />
                <Probe label="b" />
            </>,
        );

        expect(await countSettled('a')).toBe('3');
        expect(await countSettled('b')).toBe('3');
        expect(getInbox).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing when the session is not an employer session', async () => {
        authState = { idToken: 'worker-token', isAuthenticated: true, userType: 'worker' };
        renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('probe-count')).toBeInTheDocument());
        expect(getInbox).not.toHaveBeenCalled();
        expect(screen.getByTestId('probe-count').textContent).toBe('0');
    });
});

describe('markRead', () => {
    it('clears the flag and decrements the count before the write answers', async () => {
        // Never settles: what the employer sees WHILE the POST is in flight is
        // the whole point of an optimistic update.
        markConversationRead.mockReturnValue(new Promise(() => {}));
        renderProvider(<Probe />);
        expect(await countSettled()).toBe('3');

        fireEvent.click(screen.getByRole('button', { name: 'mark conv-1' }));

        expect(screen.getByTestId('probe-count').textContent).toBe('2');
        expect(screen.getByTestId('probe-conv-1').textContent).toBe('false');
        expect(markConversationRead).toHaveBeenCalledWith('test-token', 'conv-1');
    });

    it('puts the flag and the count back when the write is refused', async () => {
        markConversationRead.mockRejectedValue(new Error('conversation_not_found'));
        renderProvider(<Probe />);
        expect(await countSettled()).toBe('3');

        fireEvent.click(screen.getByRole('button', { name: 'mark conv-1' }));

        await waitFor(() => expect(screen.getByTestId('probe-conv-1').textContent).toBe('true'));
        expect(screen.getByTestId('probe-count').textContent).toBe('3');
    });

    it('does not decrement a conversation that was already read', async () => {
        renderProvider(<Probe />);
        expect(await countSettled()).toBe('3');

        fireEvent.click(screen.getByRole('button', { name: 'mark conv-1' }));
        await waitFor(() => expect(screen.getByTestId('probe-count').textContent).toBe('2'));

        // A second open of the same thread is still a read RECEIPT -- the
        // stamp is refreshed -- but the count has already been paid.
        fireEvent.click(screen.getByRole('button', { name: 'mark conv-1' }));
        await waitFor(() => expect(markConversationRead).toHaveBeenCalledTimes(2));
        expect(screen.getByTestId('probe-count').textContent).toBe('2');
    });
});

describe('the inbox poll', () => {
    it('ticks once per interval, skips a hidden tab, and catches up on return', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        renderProvider(
            <>
                <Probe label="a" />
                <Probe label="b" />
            </>,
        );
        await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(1));

        // One tick, one request -- two consumers, one poller.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(getInbox).toHaveBeenCalledTimes(2);

        // A phone in a pocket must not spend battery and quota on a count
        // nobody is reading.
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(45_000);
        });
        expect(getInbox).toHaveBeenCalledTimes(2);

        // Coming back does NOT wait out another tick: a tab hidden for an hour
        // would otherwise show an hour-old count.
        visibility.mockReturnValue('visible');
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
            await Promise.resolve();
        });
        await waitFor(() => expect(getInbox).toHaveBeenCalledTimes(3));
        visibility.mockRestore();
    });
});
