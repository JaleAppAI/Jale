'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { getInbox, markConversationRead } from '@/lib/api/employer';
import type { EmployerInboxResponse, InboxItem } from '@/lib/api/employer';
import type { ErrorKind } from '@/lib/api/errors';

/**
 * The employer's inbox, owned ONCE for the whole session, and the unread
 * signal derived from it.
 *
 * Sprint 26 (B3). Before this there was no unread signal in the UI at all.
 * `GET /employer/inbox` was read by exactly one page (the conversations
 * board, once, with no poll), and the floating drawer read a DIFFERENT
 * endpoint and only while it was open. So an employer sitting on the
 * dashboard -- where they spend their time -- had no way to learn that a
 * worker had answered. A WhatsApp reply window closes on its own; "no way to
 * learn" means a missed hire, not a late reply.
 *
 * Why a context rather than a hook each surface calls:
 *
 *  - the badge is needed in three places at once (the sidebar item, the mobile
 *    tab, the drawer's launcher pill) plus the dashboard panel, and a hook per
 *    surface is four pollers hammering one endpoint;
 *  - `markRead` has to move a number that every one of those surfaces is
 *    rendering, in the same frame, and revert it in the same frame if the
 *    write is refused. That is one piece of state, not four.
 *
 * `usePageData` does the fetching rather than a hand-rolled interval: it
 * already numbers and fences responses, aborts on unmount, skips ticks while
 * the tab is hidden, and -- the property that matters most here -- makes a
 * failed poll structurally incapable of blanking the count that is on screen.
 * A dropped tick leaves the last known badge; it does not silently read zero,
 * which is the one wrong answer this component could give (it says "nothing is
 * waiting for you").
 *
 * The count is the server's `unread_count`, held as loaded data and adjusted
 * by `markRead`, never re-derived from the items on every render: the endpoint
 * publishes it precisely so consumers do not re-implement the "across BOTH
 * tabs" rule (`EmployerInboxResponse.unread_count`).
 */

/**
 * The poll cadence, matching the conversation thread's. Messages arrive
 * through WhatsApp at human speed, and 15s is what the thread already spends
 * to feel live; a badge that updated more slowly than the transcript beside it
 * would read as broken.
 */
export const INBOX_POLL_MS = 15000;

const NO_ITEMS: InboxItem[] = [];
const NO_FLAGS: Record<string, boolean> = {};

export type UnreadMessagesValue = {
    /** Unread threads across both tabs, as the server counts them. */
    unreadCount: number;
    /** `conversation_id` -> has an unanswered worker message. */
    unreadByConversation: Record<string, boolean>;
    /**
     * The whole inbox, so the surfaces that need more than a number (the
     * drawer's list, the dashboard's latest-message panel, the applicant row's
     * "does this applicant already have a thread?") read it from here instead
     * of opening a second request for the same payload.
     */
    items: InboxItem[];
    /** True until the first inbox read lands (or forever, for a non-employer). */
    loading: boolean;
    /**
     * Why the FIRST read failed, for the surfaces that render a list from
     * `items` and owe the employer an error state rather than an empty one.
     * A failed poll never lands here -- it cannot touch loaded data.
     */
    errorKind: ErrorKind | null;
    /** Full reload after a failure: back to the skeleton, then a fresh read. */
    retry: () => void;
    /** Background reload. Never blanks what is on screen. */
    refresh: () => Promise<void>;
    /**
     * Marks a thread read: optimistic locally, then written. On a refusal the
     * flag and the count go back and the next poll settles the truth.
     *
     * Always writes, even for a thread this client already shows as read -- it
     * is a read RECEIPT, and refreshing the stamp is what stops a message that
     * arrived between two polls from being counted as unread afterwards. Only
     * the count is guarded, so a second open cannot decrement twice.
     */
    markRead: (conversationId: string) => void;
};

const UnreadMessagesContext = createContext<UnreadMessagesValue | null>(null);

/** Sets one conversation's flag and moves the count with it, clamped at zero. */
function withUnread(
    data: EmployerInboxResponse | null,
    conversationId: string,
    unread: boolean,
): EmployerInboxResponse | null {
    if (!data) return data;
    return {
        ...data,
        items: data.items.map((item) =>
            item.conversation_id === conversationId ? { ...item, unread } : item,
        ),
        unread_count: unread ? data.unread_count + 1 : Math.max(0, data.unread_count - 1),
    };
}

export function UnreadMessagesProvider({ children }: { children: ReactNode }) {
    const { idToken, isAuthenticated, userType } = useAuth();

    /*
     * Workers and signed-out visitors share this layout. The fetcher resolves
     * `null` for them rather than being skipped by a conditional hook, which
     * is the same shape the drawer uses -- and it means no employer endpoint
     * is ever touched with a worker's session.
     */
    const canFetch = isAuthenticated && userType === 'employer';

    const inbox = usePageData<EmployerInboxResponse | null>({
        fetcher: ({ token, signal }) => (canFetch ? getInbox(token, signal) : Promise.resolve(null)),
        // Mounted in the root layout, which renders the public marketing pages
        // too: the default would bounce every anonymous visitor to /auth.
        requireAuth: false,
        deps: [canFetch],
        pollMs: canFetch ? INBOX_POLL_MS : undefined,
    });

    const { data, errorKind, phase, refresh, retry, setData } = inbox;

    /** Read inside callbacks that must not re-subscribe on every response. */
    const dataRef = useRef(data);
    dataRef.current = data;
    const idTokenRef = useRef(idToken);
    idTokenRef.current = idToken;

    /*
     * Coming BACK to the tab refreshes immediately. `usePageData` skips ticks
     * while the tab is hidden (deliberately -- a phone in a pocket should not
     * spend battery and quota), but resuming the tick alone would leave a tab
     * that was hidden for an hour showing an hour-old count for up to another
     * 15 seconds, which is exactly the moment the employer is looking at it.
     */
    useEffect(() => {
        if (!canFetch) return;
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [canFetch, refresh]);

    const markRead = useCallback(
        (conversationId: string) => {
            const token = idTokenRef.current;
            if (!token) return;

            // Whether this thread is currently COUNTED, decided before the
            // optimistic write so the revert knows what to put back.
            const wasUnread = Boolean(
                dataRef.current?.items.some(
                    (item) => item.conversation_id === conversationId && item.unread,
                ),
            );
            if (wasUnread) setData((prev) => withUnread(prev, conversationId, false));

            void markConversationRead(token, conversationId).catch(() => {
                // The stamp did not land, so the thread IS still unread. Put
                // it back rather than leaving a badge that lies in the
                // reassuring direction; the next poll settles it either way.
                //
                // Guarded on the flag still being CLEAR: a poll that landed
                // between the optimistic write and this refusal has already
                // re-counted the thread, and an unconditional +1 would then
                // count it twice.
                if (!wasUnread) return;
                setData((prev) => {
                    const stillCleared = prev?.items.some(
                        (item) => item.conversation_id === conversationId && !item.unread,
                    );
                    return stillCleared ? withUnread(prev, conversationId, true) : prev;
                });
            });
        },
        [setData],
    );

    const unreadByConversation = useMemo(() => {
        if (!data) return NO_FLAGS;
        const flags: Record<string, boolean> = {};
        for (const item of data.items) {
            if (item.conversation_id) flags[item.conversation_id] = item.unread;
        }
        return flags;
    }, [data]);

    const value = useMemo<UnreadMessagesValue>(
        () => ({
            unreadCount: data?.unread_count ?? 0,
            unreadByConversation,
            items: data?.items ?? NO_ITEMS,
            loading: canFetch && phase !== 'ready' && phase !== 'error',
            errorKind: canFetch ? errorKind : null,
            retry,
            refresh,
            markRead,
        }),
        [canFetch, data, errorKind, markRead, phase, refresh, retry, unreadByConversation],
    );

    return (
        <UnreadMessagesContext.Provider value={value}>{children}</UnreadMessagesContext.Provider>
    );
}

/** The inbox and its unread signal. Throws outside the provider, like its siblings. */
export function useUnreadMessages(): UnreadMessagesValue {
    const ctx = useContext(UnreadMessagesContext);
    if (!ctx) throw new Error('useUnreadMessages must be used inside UnreadMessagesProvider');
    return ctx;
}

/**
 * Just the number, and `0` where there is no provider to ask.
 *
 * The app always has one (it is mounted in the root layout), but the nav rail
 * is also composed on its own -- by `AppShell` in suites that render a page
 * without the session providers around it, for instance. A COUNT BADGE is the
 * last thing that should be able to take a page down, and "no source of unread
 * news" and "no unread news" render identically: nothing.
 *
 * Deliberately separate from `useUnreadMessages`, which throws: anything that
 * MUTATES the count (marking read) must be inside the provider, and silently
 * no-oping there would be a bug that never announces itself.
 */
export function useUnreadCount(): number {
    return useContext(UnreadMessagesContext)?.unreadCount ?? 0;
}
