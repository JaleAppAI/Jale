'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ConversationDrawer } from '@/components/employer/ConversationDrawer';

/**
 * "Message this applicant", from anywhere in the employer app (sprint 26, B4).
 *
 * The drawer has always been mounted in the root layout, but the only way to
 * open it was its own floating button, and the only way to reach a particular
 * worker was to find them in its list. A row on the applicants board that
 * wanted to start a conversation had nowhere to send the employer except the
 * messages page.
 *
 * Same arrangement as `PostJobContext`: the provider owns the surface (it
 * mounts the drawer, which is why the layout no longer does) and hands the
 * app one verb. Pages opt in by calling `openConversation`.
 *
 * The request deliberately names the APPLICATION, not a conversation: the
 * caller is a row on a list of applicants, and whether a thread exists yet is
 * something only the inbox knows. The drawer resolves it -- landing on the
 * real transcript when there is one and on the first-message composer when
 * there is not.
 */

/**
 * Who to open, plus -- optionally -- enough to DRAW them.
 *
 * The three ids are the request. The display fields are the answer to a defect
 * the first cut of B4 shipped with: the drawer resolves the application against
 * the employer inbox, and the inbox does not list every applicant the board
 * does. It omits applicants of a job that is no longer active and who have
 * never been messaged (`infra/lambda/lib/employer-inbox.ts`: `c.id IS NOT NULL
 * OR j.status = 'active'`), and it stops at 200 rows; the applicants board has
 * no job-status filter at all. Such a row used to open on "This candidate is no
 * longer available" -- a dead end for a worker the API would happily have let
 * the employer write to.
 *
 * So a caller that already holds the applicant's name and job -- the applicants
 * board does, on every row -- passes them, and the drawer can draw the
 * first-message composer without the inbox having heard of them. Optional
 * because a caller that has only the ids is still a valid caller: it gets the
 * unavailable state, which for it is the honest answer.
 */
export type ConversationTarget = {
    application_id: string;
    worker_id: string;
    job_id: string;
    /** The four fields `EmptyThreadComposer`'s header renders. */
    worker_name?: string | null;
    job_title?: string;
    job_city?: string | null;
    applied_at?: string;
};

/**
 * A request to open the drawer. `token` rises on every call so that asking
 * twice for the SAME applicant re-opens a drawer the employer has since
 * closed -- without it the second click would be a no-op, which reads as a
 * broken button.
 */
export type ConversationOpenRequest = { target: ConversationTarget; token: number };

type ConversationDrawerValue = {
    openConversation: (target: ConversationTarget) => void;
    /** Read by the drawer. `null` until something asks for a thread. */
    openRequest: ConversationOpenRequest | null;
};

const ConversationDrawerContext = createContext<ConversationDrawerValue | null>(null);

export function ConversationDrawerProvider({ children }: { children: ReactNode }) {
    const [openRequest, setOpenRequest] = useState<ConversationOpenRequest | null>(null);

    const openConversation = useCallback((target: ConversationTarget) => {
        setOpenRequest((prev) => ({ target, token: (prev?.token ?? 0) + 1 }));
    }, []);

    const value = useMemo<ConversationDrawerValue>(
        () => ({ openConversation, openRequest }),
        [openConversation, openRequest],
    );

    return (
        <ConversationDrawerContext.Provider value={value}>
            {children}
            <ConversationDrawer />
        </ConversationDrawerContext.Provider>
    );
}

/** The verb. Throws outside the provider, like its siblings. */
export function useConversationDrawer(): ConversationDrawerValue {
    const ctx = useContext(ConversationDrawerContext);
    if (!ctx) {
        throw new Error('useConversationDrawer must be used inside ConversationDrawerProvider');
    }
    return ctx;
}
