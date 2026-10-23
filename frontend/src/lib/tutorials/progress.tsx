'use client';

import {
    createContext,
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePathname } from '@/i18n/navigation';
import { locales } from '@/i18n/locales';
import { accountKeyFromIdToken } from '@/lib/account-key';
import {
    EMPLOYER_TUTORIAL_IDS,
    getTutorialProgress,
    recordTutorialOutcome,
    type TutorialId,
    type TutorialOutcome,
    type TutorialRecord,
    type TutorialRole,
} from '@/lib/api/tutorials';
import { TutorialPlayer } from '@/components/tutorials/TutorialPlayer';
import { useOverlayRegistry } from './overlay';
import { getTutorial } from './registry';
import { clearRecordFailed, readRecordFailed, writeRecordFailed } from './storage';
import type { TutorialSceneProps } from './types';

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
 *
 * PLAYS. The store also renders the ONE tutorial player, and owns the rule
 * that keeps a single dialog on screen (ruling R4):
 *  - a play is first PENDING, and is only shown after the commit that queued
 *    it, from a passive effect, when every overlay that opened in that same
 *    commit has registered. An auto play refused there (an overlay is up)
 *    never shows; a "before the host" play then opens its host instead;
 *  - one play at a time: a request while another is pending or up is refused;
 *  - a play's `then` (the host it plays before) runs from a post-commit effect
 *    AFTER the player has unmounted: Modal's cleanups have already handed the
 *    scroll lock and the focus back, so the host opens from the real button
 *    and locks the page afresh;
 *  - only AUTO plays record their outcome. Replays never do.
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
    /** Queues a play; false (and nothing queued) when another is already pending or up. */
    play(request: PlayRequest): boolean;
    /** Drops a play `source` queued that has not shown yet (its page went away). */
    cancel(source: object): void;
    /** True while a play is pending or up. */
    isBusy(): boolean;
    /** True while any other overlay is open (see `./overlay`). */
    isOverlayPresent(): boolean;
    /** Keeps the latest vars a host gave for `id`, so a Help replay draws the same picture. */
    rememberVars(id: TutorialId, vars: TutorialVars): void;
    varsFor(id: TutorialId): TutorialVars;
};

export type TutorialVars = TutorialSceneProps['vars'];

export type PlayRequest = {
    id: TutorialId;
    vars?: TutorialVars;
    /** `auto` plays obey the overlay rule and record their outcome; `replay` plays do neither. */
    mode: 'auto' | 'replay';
    /** Runs once the play's dialog has gone, or at once if it is refused: the host it plays before. */
    then?: () => void;
    /** Called when the play is refused at the last check. */
    onRefused?: () => void;
    /** Who asked, for `cancel`. */
    source?: object;
};

type Play = PlayRequest & { seq: number };
type PlayState = { readonly pending: Play | null; readonly active: Play | null };

const NO_PLAY: PlayState = { pending: null, active: null };

/**
 * The play state, kept outside React (read with `useSyncExternalStore`) so a
 * host's handler can ask "is a tutorial busy?" and get this instant's answer,
 * not the last render's.
 */
function createPlayStore() {
    let state: PlayState = NO_PLAY;
    let seq = 0;
    const listeners = new Set<() => void>();
    /** Hosts waiting for the play that just ended to leave the page. */
    let afterClose: Array<() => void> = [];
    const set = (next: PlayState) => {
        state = next;
        listeners.forEach((listener) => listener());
    };
    return {
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => state,
        isBusy: () => state.pending !== null || state.active !== null,
        request(request: PlayRequest): boolean {
            if (state.pending !== null || state.active !== null) return false;
            seq += 1;
            set({ pending: { ...request, seq }, active: null });
            return true;
        },
        /** The last check before a pending play shows. Returns the play when refused. */
        settle(refuse: (play: Play) => boolean): Play | null {
            const pending = state.pending;
            if (pending === null) return null;
            if (refuse(pending)) {
                set(NO_PLAY);
                return pending;
            }
            set({ pending: null, active: pending });
            return null;
        },
        /** Ends the play on screen. Its `then` waits for the commit that removes it. */
        finish(): Play | null {
            const active = state.active;
            if (active === null) return null;
            if (active.then) afterClose.push(active.then);
            set(NO_PLAY);
            return active;
        },
        takeAfterClose(): Array<() => void> {
            const tasks = afterClose;
            afterClose = [];
            return tasks;
        },
        cancel(source: object) {
            if (state.pending?.source === source) set({ pending: null, active: state.active });
        },
        /** The session ended: nothing plays, and no host waits on a play. */
        reset() {
            afterClose = [];
            if (state !== NO_PLAY) set(NO_PLAY);
        },
    };
}

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

/** Whose tutorial `id` is: the contract's id lists, not the route it is shown on. */
export function roleOfTutorial(id: TutorialId): TutorialRole {
    return (EMPLOYER_TUTORIAL_IDS as readonly TutorialId[]).includes(id) ? 'employer' : 'worker';
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
    const latest = useRef({ token: idToken, userType, role, account, loadKey, entries });
    useIsomorphicLayoutEffect(() => {
        latest.current = { token: idToken, userType, role, account, loadKey, entries };
    });

    /** Failed saves this page load knows about, whatever storage can hold. */
    const flagsRef = useRef(new Set<string>());
    /** The latest vars each host gave, for Help replays. */
    const varsRef = useRef(new Map<TutorialId, NonNullable<TutorialVars>>());

    const overlays = useOverlayRegistry();
    const [plays] = useState(createPlayStore);
    const playState = useSyncExternalStore(plays.subscribe, plays.getSnapshot, plays.getSnapshot);

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
        varsRef.current.clear();
        // Whatever was playing belonged to the session that ended.
        plays.reset();
    }, [sessionCleared, plays]);

    // THE LAST CHECK before a pending play shows. A passive effect, so every
    // overlay that opened in the commit that queued the play (wherever it
    // sits in the tree) has already registered in its layout phase.
    const pending = playState.pending;
    useEffect(() => {
        if (pending === null) return;
        const refused = plays.settle(
            (play) =>
                !getTutorial(play.id)?.slides.length ||
                (play.mode === 'auto' && (overlays?.isPresent() ?? false)),
        );
        if (refused) {
            refused.onRefused?.();
            // Nothing showed, so the host it was to play before opens now.
            refused.then?.();
        }
    }, [pending, plays, overlays]);

    // A host waiting on the play that just ended. This runs after the commit
    // that unmounted the player, once Modal's cleanups have released the
    // scroll lock and returned focus, so the host reads the real opener.
    useEffect(() => {
        for (const task of plays.takeAfterClose()) task();
    }, [playState, plays]);

    const hasRecord = useCallback(
        (id: TutorialId) => entry?.state === 'ready' && entry.records.has(id),
        [entry],
    );

    const isFlagged = useCallback(
        (id: TutorialId) => flagsRef.current.has(flagKey(role, account, id)) || readRecordFailed(id, account),
        [role, account],
    );

    const recordOutcome = useCallback((id: TutorialId, outcome: TutorialOutcome) => {
        // The role comes from the tutorial, not from the route: the player
        // stays up across a navigation, so Skip or Got it may be pressed on a
        // page outside the shell (a browser Back to the landing page), and the
        // outcome still belongs to the account that was shown it.
        const role = roleOfTutorial(id);
        const { token, userType: signedInAs, account: servingAccount } = latest.current;
        // Only an account signed in as that role can record it (the backend
        // would refuse anything else as invalid_tutorial).
        if (signedInAs !== role) return;
        // The same key the read stores this account's records under.
        const key = token ? `${role}:${servingAccount ?? token}` : null;

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
            flagsRef.current.add(flagKey(role, servingAccount, id));
            writeRecordFailed(id, servingAccount);
        };
        if (!token) {
            flag();
            return;
        }
        recordTutorialOutcome(token, role, id, outcome).then(markRecorded, flag);
    }, []);

    const play = useCallback((request: PlayRequest) => plays.request(request), [plays]);
    const cancel = useCallback((source: object) => plays.cancel(source), [plays]);
    const isBusy = useCallback(() => plays.isBusy(), [plays]);
    const isOverlayPresent = useCallback(() => overlays?.isPresent() ?? false, [overlays]);
    const rememberVars = useCallback((id: TutorialId, vars: TutorialVars) => {
        if (vars !== undefined) varsRef.current.set(id, vars);
    }, []);
    const varsFor = useCallback((id: TutorialId) => varsRef.current.get(id), []);

    const onDismiss = useCallback(
        (outcome: TutorialOutcome) => {
            const ended = plays.finish();
            if (ended?.mode === 'auto') recordOutcome(ended.id, outcome);
        },
        [plays, recordOutcome],
    );

    const value = useMemo<TutorialProgressValue>(
        () => ({
            shellRole,
            role,
            status,
            hasRecord,
            isFlagged,
            recordOutcome,
            play,
            cancel,
            isBusy,
            isOverlayPresent,
            rememberVars,
            varsFor,
        }),
        [shellRole, role, status, hasRecord, isFlagged, recordOutcome, play, cancel, isBusy, isOverlayPresent, rememberVars, varsFor],
    );

    const active = playState.active;
    const activeDefinition = active !== null ? getTutorial(active.id) : undefined;

    return (
        <TutorialProgressContext value={value}>
            {children}
            {active !== null && activeDefinition ? (
                <TutorialPlayer
                    key={active.seq}
                    definition={activeDefinition}
                    vars={active.vars}
                    onDismiss={onDismiss}
                />
            ) : null}
        </TutorialProgressContext>
    );
}
