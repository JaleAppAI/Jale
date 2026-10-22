'use client';

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePathname } from '@/i18n/navigation';
import { locales } from '@/i18n/locales';
import { accountKeyFromIdToken } from '@/lib/account-key';
import {
    getTutorialProgress,
    recordTutorialOutcome,
    type TutorialId,
    type TutorialOutcome,
    type TutorialRecord,
    type TutorialRole,
} from '@/lib/api/tutorials';
import { clearRecordFailed, readRecordFailed, writeRecordFailed } from './storage';

/**
 * The tutorial progress store (contract K1): which tutorials this account has
 * already finished or skipped, read ONCE per session, and how an auto-opened
 * tutorial was dismissed, recorded when it closes.
 *
 * Mounted once, in `app/[locale]/layout.tsx` inside `AuthProvider` (ruling
 * R1), not in `AppShell`: every page mounts its own shell, so a store there
 * would read again on every navigation, and worker onboarding has no shell.
 *
 * WHEN IT READS. Only on a signed-in SHELL route (`/employer/*` or
 * `/worker/*`) while signed in as that route's role, with a token. Signed-out
 * visitors and public pages (the landing page, a shared job link, the sign-in
 * screens) make no tutorial request at all.
 *
 * WHAT IT IS KEYED BY. The role and the ACCOUNT (`accountKeyFromIdToken`),
 * not the token: Cognito rotates the token every hour, and a rotation is the
 * same person. A different account on the same phone reads again, and the
 * previous account's records are dropped. So is everything when the session
 * ends (`sessionCleared`), the explicit announcement `SidebarProfileContext`
 * uses, rather than `isAuthenticated` going false, which also happens during
 * a role switch.
 *
 * FAILURE RULES (K1.4).
 *  - A failed read means nothing auto-opens on this page load. It is not
 *    retried; Help replay still works.
 *  - A failed save flags the tutorial for the rest of the browser session
 *    (`./storage`, account-scoped), plus an in-memory copy for when storage is
 *    unavailable or the account cannot be read. The save is never retried.
 *  - Nothing is ever written on render.
 */

export type TutorialProgressStatus =
    /** No read on this route: signed out, a public page, or the other role. */
    | 'idle'
    /** The read (or the session restore before it) has not answered yet. */
    | 'loading'
    | 'ready'
    | 'failed';

export type TutorialProgressValue = {
    /** The role whose shell this route belongs to, signed in or not. Help lists its tutorials. */
    shellRole: TutorialRole | null;
    /** The role whose progress is loaded: the shell role, while signed in as it. */
    role: TutorialRole | null;
    status: TutorialProgressStatus;
    /** True once this account has an outcome for `id`, including one recorded in this session. */
    hasRecord(id: TutorialId): boolean;
    /** True when saving `id`'s outcome failed earlier in this browser session. */
    isFlagged(id: TutorialId): boolean;
    /** Records how an AUTO-OPENED play of `id` was dismissed. Replays never call this. */
    recordOutcome(id: TutorialId, outcome: TutorialOutcome): void;
};

const TutorialProgressContext = createContext<TutorialProgressValue | null>(null);

/** The store, or null outside the provider (tests, and any tree mounted without it). */
export function useTutorialProgress(): TutorialProgressValue | null {
    return use(TutorialProgressContext);
}

type Entry =
    | { state: 'ready'; records: ReadonlyMap<TutorialId, TutorialRecord> }
    | { state: 'failed' };

/** The shell a route belongs to, from its locale-free path. */
export function shellRoleFromPath(pathname: string | null | undefined): TutorialRole | null {
    if (!pathname) return null;
    // `usePathname` from the intl navigation already drops the locale; strip
    // one defensively anyway so a prefixed path cannot read as public.
    const localeFree = pathname.replace(new RegExp(`^/(${locales.join('|')})(?=/|$)`), '');
    if (/^\/employer(\/|$)/.test(localeFree)) return 'employer';
    if (/^\/worker(\/|$)/.test(localeFree)) return 'worker';
    return null;
}

function roleOfKey(key: string): string {
    return key.slice(0, key.indexOf(':'));
}

function flagKey(role: TutorialRole | null, account: string | null, id: TutorialId): string {
    return `${role ?? '-'}:${account ?? '-'}:${id}`;
}

/** Client-side `useLayoutEffect`, server-side `useEffect` (the shell renders on the server too). */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function TutorialProgressProvider({ children }: { children: ReactNode }) {
    const { idToken, userType, isAuthenticated, isLoading, sessionCleared } = useAuth();
    const shellRole = shellRoleFromPath(usePathname());
    const account = accountKeyFromIdToken(idToken);
    const role: TutorialRole | null =
        shellRole !== null && isAuthenticated && userType === shellRole && idToken ? shellRole : null;
    // An undecodable token falls back to the token itself: the odd extra read
    // rather than no progress at all (the `SidebarProfileContext` rule).
    const loadKey = role !== null && idToken ? `${role}:${account ?? idToken}` : null;

    const [entries, setEntries] = useState<Readonly<Record<string, Entry>>>({});
    const entry = loadKey !== null ? entries[loadKey] : undefined;

    let status: TutorialProgressStatus;
    if (shellRole === null) status = 'idle';
    else if (loadKey !== null) status = entry?.state ?? 'loading';
    else status = isLoading ? 'loading' : 'idle';

    // The latest of each, for callbacks that must not change identity (and so
    // re-render every consumer) on every token rotation.
    const latest = useRef({ token: idToken, role, account, loadKey, entries });
    useIsomorphicLayoutEffect(() => {
        latest.current = { token: idToken, role, account, loadKey, entries };
    });

    /** Failed saves this page load knows about, whatever storage can hold. */
    const flagsRef = useRef(new Set<string>());

    // THE READ: once per role + account. Superseded or unmounted reads are
    // aborted, and their answers dropped.
    useEffect(() => {
        if (loadKey === null || role === null) return;
        const { token, entries: known } = latest.current;
        if (known[loadKey] || !token) return;

        const controller = new AbortController();
        const settle = (next: Entry) => {
            if (controller.signal.aborted) return;
            setEntries((prev) => {
                // One account per role at a time: another account's records
                // on this phone are not this person's.
                const kept: Record<string, Entry> = {};
                for (const [key, value] of Object.entries(prev)) {
                    if (roleOfKey(key) !== role) kept[key] = value;
                }
                kept[loadKey] = next;
                return kept;
            });
        };
        getTutorialProgress(token, role, controller.signal).then(
            (records) => settle({ state: 'ready', records: new Map(records.map((item) => [item.tutorial_id, item])) }),
            () => settle({ state: 'failed' }),
        );
        return () => controller.abort();
    }, [loadKey, role]);

    // THE SESSION ENDED: drop what was read for that role (or both), and the
    // flags with it. Only `sessionCleared`, never `isAuthenticated` going
    // false: that also happens mid role switch, which ends nothing.
    const clearedEpochRef = useRef(sessionCleared.epoch);
    useEffect(() => {
        if (sessionCleared.epoch === clearedEpochRef.current) return;
        clearedEpochRef.current = sessionCleared.epoch;
        const cleared = sessionCleared.role;
        setEntries((prev) => {
            const kept: Record<string, Entry> = {};
            for (const [key, value] of Object.entries(prev)) {
                if (cleared !== null && roleOfKey(key) !== cleared) kept[key] = value;
            }
            return kept;
        });
        for (const key of Array.from(flagsRef.current)) {
            if (cleared === null || key.startsWith(`${cleared}:`)) flagsRef.current.delete(key);
        }
        clearRecordFailed(cleared ?? undefined);
    }, [sessionCleared]);

    const hasRecord = useCallback(
        (id: TutorialId) => entry?.state === 'ready' && entry.records.has(id),
        [entry],
    );

    const isFlagged = useCallback(
        (id: TutorialId) => flagsRef.current.has(flagKey(role, account, id)) || readRecordFailed(id, account),
        [role, account],
    );

    const recordOutcome = useCallback((id: TutorialId, outcome: TutorialOutcome) => {
        const { token, role: servingRole, account: servingAccount, loadKey: key } = latest.current;
        // A tutorial of the other role is not this account's to record (the
        // backend would refuse it as invalid_tutorial anyway).
        if (servingRole === null || !id.startsWith(`${servingRole}_`)) return;

        const markRecorded = (stored: TutorialRecord) =>
            setEntries((prev) => {
                const current = key !== null ? prev[key] : undefined;
                if (key === null || current?.state !== 'ready') return prev;
                const records = new Map(current.records);
                records.set(id, stored);
                return { ...prev, [key]: { state: 'ready', records } };
            });
        // Optimistic: the tutorial counts as done for the rest of this page
        // load whatever the save does, so it cannot re-open on the next page.
        markRecorded({ tutorial_id: id, outcome, recorded_at: new Date().toISOString() });

        const flag = () => {
            flagsRef.current.add(flagKey(servingRole, servingAccount, id));
            writeRecordFailed(id, servingAccount);
        };
        if (!token) {
            flag();
            return;
        }
        recordTutorialOutcome(token, servingRole, id, outcome).then(markRecorded, flag);
    }, []);

    const value = useMemo<TutorialProgressValue>(
        () => ({ shellRole, role, status, hasRecord, isFlagged, recordOutcome }),
        [shellRole, role, status, hasRecord, isFlagged, recordOutcome],
    );

    return <TutorialProgressContext value={value}>{children}</TutorialProgressContext>;
}
