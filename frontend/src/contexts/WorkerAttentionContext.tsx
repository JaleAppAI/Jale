'use client';

import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { getApplicationsAttention } from '@/lib/api/worker';
import type { ApplicationsAttention } from '@/lib/api/worker';
import type { ErrorKind } from '@/lib/api/errors';

/**
 * What needs the worker -- an employer waiting on their details, a hire nobody
 * has told them about -- owned ONCE for the session (F27, sprint 28).
 *
 * The worker app had no shared source for it: the home page derived it per
 * visit and the nav had nothing, so the one thing a worker opens the app for
 * showed nowhere until they happened to open home. Same arrangement as
 * `UnreadMessagesContext`: `usePageData` fetches (numbered responses, abort on
 * unmount, hidden-tab skips, and a failed poll that cannot blank what is on
 * screen), the nav reads the count, the home page reads the summary.
 */

/** Details requests move at employer speed; a minute keeps the badge honest without spending a phone's quota. */
export const ATTENTION_POLL_MS = 60_000;

/**
 * A failed FIRST read leaves `usePageData` in `error`, where it never polls
 * again. Without a retry the badge would stay at zero for the rest of the
 * session -- the reassuring wrong answer.
 */
export const ATTENTION_RETRY_MS = 60_000;

export type WorkerAttentionValue = {
    attention: ApplicationsAttention | null;
    count: number;
    loading: boolean;
    errorKind: ErrorKind | null;
    refresh: () => Promise<void>;
    forgetHire: (applicationId: string) => void;
};

const WorkerAttentionContext = createContext<WorkerAttentionValue | null>(null);

/** The badge number: details requests plus unacknowledged hires. */
export function attentionCount(attention: ApplicationsAttention | null): number {
    if (!attention) return 0;
    return attention.details_requested.length + attention.unacknowledged_hires.length;
}

export function WorkerAttentionProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, userType } = useAuth();

    // Employers and visitors share this layout. The fetcher resolves null for
    // them rather than being skipped by a conditional hook, and `role` keeps
    // the worker's token the only one ever sent.
    const canFetch = isAuthenticated && userType === 'worker';

    const summary = usePageData<ApplicationsAttention | null>({
        fetcher: ({ token, signal }) => (canFetch ? getApplicationsAttention(token, signal) : Promise.resolve(null)),
        // Mounted in the root layout, which renders public pages too.
        requireAuth: false,
        role: 'worker',
        deps: [canFetch],
        pollMs: canFetch ? ATTENTION_POLL_MS : undefined,
    });

    const { data, errorKind, phase, refresh, retry, setData } = summary;

    // Coming back to the tab refreshes at once, as the unread badge does.
    useEffect(() => {
        if (!canFetch) return;
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [canFetch, refresh]);

    useEffect(() => {
        if (!canFetch || phase !== 'error') return;
        const id = window.setTimeout(retry, ATTENTION_RETRY_MS);
        return () => window.clearTimeout(id);
    }, [canFetch, phase, retry]);

    const forgetHire = useCallback((applicationId: string) => {
        setData((prev) => (prev
            ? {
                ...prev,
                unacknowledged_hires: prev.unacknowledged_hires.filter((hire) => hire.application_id !== applicationId),
            }
            : prev));
    }, [setData]);

    const attention = canFetch ? data : null;

    const value = useMemo<WorkerAttentionValue>(() => ({
        attention,
        count: attentionCount(attention),
        loading: canFetch && phase !== 'ready' && phase !== 'error',
        errorKind: canFetch ? errorKind : null,
        refresh,
        forgetHire,
    }), [attention, canFetch, errorKind, forgetHire, phase, refresh]);

    return <WorkerAttentionContext.Provider value={value}>{children}</WorkerAttentionContext.Provider>;
}

/** The summary and its controls. Throws outside the provider, like its siblings. */
export function useWorkerAttention(): WorkerAttentionValue {
    const ctx = useContext(WorkerAttentionContext);
    if (!ctx) throw new Error('useWorkerAttention must be used inside WorkerAttentionProvider');
    return ctx;
}

/**
 * Just the number, and 0 where there is no provider -- the nav rails are also
 * composed outside the session tree (page suites), and a count badge is the
 * last thing that should take a page down. Same reasoning as `useUnreadCount`.
 */
export function useWorkerAttentionCount(): number {
    return useContext(WorkerAttentionContext)?.count ?? 0;
}
