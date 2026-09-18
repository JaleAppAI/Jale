// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

/*
 * The read-receipt rule, on its own.
 *
 * Both surfaces that open a thread (the drawer and the conversations page)
 * share it, and the three ways to get it wrong are all invisible until
 * someone's badge misbehaves: writing on every render, writing on every poll
 * tick, and -- the one the drawer suite cannot reach -- writing while the
 * employer is not actually looking, which clears a badge for a message they
 * have not seen.
 */

const markRead = vi.fn();
vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({ markRead }),
}));

import { useThreadReadReceipt } from '@/hooks/useThreadReadReceipt';

function Probe({
    conversationId,
    lastWorkerMessageAt,
    active = true,
}: {
    conversationId: string | null;
    lastWorkerMessageAt: string | null;
    active?: boolean;
}) {
    useThreadReadReceipt({ conversationId, lastWorkerMessageAt, active });
    return <div>thread</div>;
}

let visibility: ReturnType<typeof vi.spyOn> | null = null;

function setHidden(hidden: boolean) {
    visibility?.mockRestore();
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible');
}

beforeEach(() => {
    markRead.mockReset();
    markRead.mockResolvedValue(true);
    // jsdom reports an unfocused document unless something has been clicked,
    // and "is the employer actually looking at this?" is half the rule -- so
    // the answer is stated explicitly rather than inherited from the harness.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
    visibility?.mockRestore();
    visibility = null;
    vi.restoreAllMocks();
});

describe('useThreadReadReceipt', () => {
    it('writes one receipt per opened thread, however many times it re-renders', () => {
        const { rerender } = render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);
        rerender(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);
        rerender(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);

        expect(markRead).toHaveBeenCalledTimes(1);
        expect(markRead).toHaveBeenCalledWith('conv-1');
    });

    it('writes again for the next thread, and again on returning to the first', () => {
        const { rerender } = render(<Probe conversationId="conv-1" lastWorkerMessageAt={null} />);
        rerender(<Probe conversationId="conv-2" lastWorkerMessageAt={null} />);
        rerender(<Probe conversationId="conv-1" lastWorkerMessageAt={null} />);

        expect(markRead.mock.calls.map(([id]) => id)).toEqual(['conv-1', 'conv-2', 'conv-1']);
    });

    it('writes again when the worker has written since the last receipt', () => {
        const { rerender } = render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);
        rerender(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T11:00:00Z" />);

        expect(markRead).toHaveBeenCalledTimes(2);
    });

    it('writes nothing while the surface holding the thread is closed', () => {
        render(<Probe conversationId="conv-1" lastWorkerMessageAt={null} active={false} />);

        expect(markRead).not.toHaveBeenCalled();
    });

    it('writes nothing while the window sits behind another one', () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);

        expect(markRead).not.toHaveBeenCalled();

        // Clicking back into the window is what reads it.
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        act(() => {
            window.dispatchEvent(new Event('focus'));
        });

        expect(markRead).toHaveBeenCalledTimes(1);
    });

    it('tries again when the write was refused', async () => {
        // A receipt that did not land is not a receipt. Before this, the ref
        // said "done" the moment the POST was sent, so one refusal left the
        // thread badged for as long as it stayed open.
        markRead.mockResolvedValueOnce(false);
        render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);
        await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));

        act(() => {
            window.dispatchEvent(new Event('focus'));
        });

        await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
        expect(markRead).toHaveBeenLastCalledWith('conv-1');
    });

    it('does not retry a receipt that landed', async () => {
        render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);
        await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));

        act(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(markRead).toHaveBeenCalledTimes(1);
    });

    it('gives back only its own claim when a refusal lands late', async () => {
        // The refusal for conv-1 arrives after the employer has moved on. It
        // must not make conv-2 -- already receipted -- write again.
        let refuseFirst: ((written: boolean) => void) | null = null;
        markRead.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            refuseFirst = resolve;
        }));
        const { rerender } = render(<Probe conversationId="conv-1" lastWorkerMessageAt={null} />);
        await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));

        rerender(<Probe conversationId="conv-2" lastWorkerMessageAt={null} />);
        await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));

        await act(async () => {
            refuseFirst?.(false);
            await Promise.resolve();
        });
        act(() => {
            window.dispatchEvent(new Event('focus'));
        });

        // conv-2's receipt stands; nothing re-fires for the thread on screen.
        expect(markRead).toHaveBeenCalledTimes(2);
    });

    it('defers the receipt of a background tab until the employer comes back', () => {
        setHidden(true);
        render(<Probe conversationId="conv-1" lastWorkerMessageAt="2026-09-16T10:00:00Z" />);

        // A message that landed while the tab was in the background keeps its
        // badge: nobody has read it.
        expect(markRead).not.toHaveBeenCalled();

        setHidden(false);
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(markRead).toHaveBeenCalledTimes(1);
    });
});
