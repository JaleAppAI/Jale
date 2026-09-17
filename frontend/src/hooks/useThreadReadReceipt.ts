'use client';

import { useEffect, useRef, useState } from 'react';
import { useUnreadMessages } from '@/contexts/UnreadMessagesContext';

/**
 * Marks the thread the employer is looking at as read (sprint 26, B3).
 *
 * The rule is one line long and every wrong version of it is a bug people
 * notice: mark ONCE per opened thread, and again only when a NEW worker
 * message arrives while the employer is actually looking at it.
 *
 *  - once per open, not per render: a render-time call would fire on every
 *    keystroke in the composer;
 *  - not per poll: the thread re-fetches every 15 seconds, and a POST per tick
 *    would be a write loop for as long as the drawer stays open;
 *  - but again on a NEW message, or a thread left open all afternoon would
 *    keep collecting a badge for messages the employer is watching arrive.
 *
 * The stamp, not a boolean, is what makes those three the same rule: the
 * effect re-runs exactly when the conversation changes or the worker has
 * written since the last receipt.
 *
 * `lastWorkerMessageAt` should come from the INBOX item rather than the loaded
 * transcript. It is the same value the server derives `unread` from, it is
 * there before the thread request lands (so opening a thread does not write
 * twice -- once for "no stamp yet" and once for the real one), and it is
 * refreshed by the one poll this app runs.
 *
 * VISIBILITY is part of "looking at it": a message that arrives while the tab
 * is in the background must keep its badge until the employer comes back. The
 * focus/visibility listener is what lets that deferred receipt fire on return,
 * since neither id nor stamp changes at that moment.
 */
export function useThreadReadReceipt({
    conversationId,
    lastWorkerMessageAt,
    active,
}: {
    /** The open thread, or null when none is. */
    conversationId: string | null;
    /** The inbox's `last_worker_message_at` for that thread. */
    lastWorkerMessageAt: string | null;
    /** False while the surface holding the thread is closed or hidden. */
    active: boolean;
}): void {
    const { markRead } = useUnreadMessages();
    /** The (thread, worker-message) pair this session has already receipted. */
    const receiptedRef = useRef<{ id: string; stamp: string | null } | null>(null);
    const [returnToken, setReturnToken] = useState(0);

    useEffect(() => {
        const bump = () => setReturnToken((token) => token + 1);
        window.addEventListener('focus', bump);
        document.addEventListener('visibilitychange', bump);
        return () => {
            window.removeEventListener('focus', bump);
            document.removeEventListener('visibilitychange', bump);
        };
    }, []);

    useEffect(() => {
        if (!active || !conversationId) return;
        if (document.visibilityState === 'hidden') return;
        // `hasFocus` is absent in some test DOMs; an environment that cannot
        // answer is treated as focused rather than never marking anything.
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;

        const receipted = receiptedRef.current;
        if (receipted && receipted.id === conversationId && receipted.stamp === lastWorkerMessageAt) {
            return;
        }
        /*
         * Claimed BEFORE the write so a re-render mid-flight cannot fire a
         * second POST for the same thread -- and given back if the write is
         * refused, because a receipt that did not land is not a receipt. Until
         * this gave it back, one failed POST left a thread badged for as long
         * as it stayed open: the ref said "done", so nothing ever tried again.
         *
         * The retry rides the next natural trigger (a focus or visibility
         * bump, a newer worker message, reopening the thread) rather than
         * firing immediately, which would be an unbounded loop against a
         * server that is refusing.
         *
         * `Promise.resolve` because the value is only contractually a promise:
         * a caller that hands this hook a synchronous stub still works, and is
         * read as "assume it landed" rather than crashing on `.then`.
         */
        const claim = { id: conversationId, stamp: lastWorkerMessageAt };
        receiptedRef.current = claim;
        void Promise.resolve(markRead(conversationId)).then((written) => {
            // Only ever gives back ITS OWN claim: by the time a refusal lands
            // the employer may have opened another thread, and clearing that
            // one's receipt would write a duplicate.
            if (written === false && receiptedRef.current === claim) receiptedRef.current = null;
        });
    }, [active, conversationId, lastWorkerMessageAt, markRead, returnToken]);
}
