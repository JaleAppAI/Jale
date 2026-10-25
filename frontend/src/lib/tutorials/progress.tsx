'use client';

import {
    Suspense,
    createContext,
    lazy,
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
    DEFAULT_TUTORIAL_SETTINGS,
    EMPLOYER_TOUR_IDS,
    EMPLOYER_TUTORIAL_IDS,
    WORKER_TOUR_IDS,
    getTutorialProgress,
    recordTutorialOutcome,
    type ProgressId,
    type TourId,
    type TutorialId,
    type TutorialOutcome,
    type TutorialRecord,
    type TutorialRole,
    type TutorialSettings,
    type TutorialSettingsPatch,
} from '@/lib/api/tutorials';
import { useOverlayRegistry } from './overlay';
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
 *  - only AUTO plays record their outcome, and ALWAYS plays (guides shown
 *    every time, K1-v2) record one only when the account has none yet, so
 *    the first outcome still wins. Replays never record;
 *  - a tour id (`EMPLOYER_TOUR_IDS`, `WORKER_TOUR_IDS`) plays in the app
 *    tour overlay (`AppTourHost`), every other id in the slide player. Each
 *    has its own lazy chunk.
 *
 * THE PLAYER'S OWN CHUNK. The player, every tutorial's content and the scene
 * kit load with `React.lazy` (`TutorialHost`), first when the progress read
 * succeeds (a tutorial may auto-open on this page) and at the latest when a
 * play is asked for. Public pages never fetch them. A pending play waits for
 * the chunk, unseen, and the last check above runs once it has arrived, right
 * before the dialog mounts. A chunk that cannot be fetched refuses the play,
 * so a "before the host" host simply opens, and the next play asks again.
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
    hasRecord(id: ProgressId): boolean;
    /** True when saving `id`'s outcome failed earlier in this browser session. */
    isFlagged(id: ProgressId): boolean;
    /** Records how an AUTO-OPENED play of `id` was dismissed. Replays never call this. */
    recordOutcome(id: ProgressId, outcome: TutorialOutcome): void;
    /**
     * The account's guide settings (K1-v2): `DEFAULT_TUTORIAL_SETTINGS` until
     * the read answers, and whenever it failed.
     */
    settings: TutorialSettings;
    /** Saves a settings change (optimistic; rolled back if the save fails). */
    updateSettings(patch: TutorialSettingsPatch): void;
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
    /** A tutorial plays in the slide player; a tour id plays in the app tour overlay. */
    id: ProgressId;
    vars?: TutorialVars;
    /**
     * `auto` plays obey the overlay rule and record their outcome. `always`
     * plays (the "every time" setting) obey the overlay rule too, and record
     * only when the account has no outcome yet. `replay` plays do neither.
     */
    mode: PlayMode;
    /** Runs once the play's dialog has gone, or at once if it is refused: the host it plays before. */
    then?: () => void;
    /** Called when the play is refused at the last check. */
    onRefused?: () => void;
    /** Who asked, for `cancel`. */
    source?: object;
};

export type PlayMode = 'auto' | 'always' | 'replay';

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

type TutorialHostModule = typeof import('@/components/tutorials/TutorialHost');
type AppTourHostModule = typeof import('@/components/tutorials/AppTourHost');

let hostModule: Promise<TutorialHostModule> | null = null;
let tourModule: Promise<AppTourHostModule> | null = null;

/** The player's chunk, fetched once; a failed fetch is forgotten so the next play retries. */
function loadTutorialHost(): Promise<TutorialHostModule> {
    hostModule ??= import('@/components/tutorials/TutorialHost').catch((error: unknown) => {
        hostModule = null;
        throw error;
    });
    return hostModule;
}

/** The app tour's chunk, on the same terms as the player's. */
function loadAppTourHost(): Promise<AppTourHostModule> {
    tourModule ??= import('@/components/tutorials/AppTourHost').catch((error: unknown) => {
        tourModule = null;
        throw error;
    });
    return tourModule;
}

const TutorialHost = lazy(loadTutorialHost);
const AppTourHost = lazy(loadAppTourHost);

const TOUR_IDS: readonly ProgressId[] = [...EMPLOYER_TOUR_IDS, ...WORKER_TOUR_IDS];

/** True for an app tour id: it plays in the tour overlay, not the slide player. */
export function isTourId(id: ProgressId): id is TourId {
    return TOUR_IDS.includes(id);
}

/** The chunk that draws `id`'s play. */
function loadRendererFor(id: ProgressId): Promise<unknown> {
    return isTourId(id) ? loadAppTourHost() : loadTutorialHost();
}

const TutorialProgressContext = createContext<TutorialProgressValue | null>(null);

/** The store, or null outside the provider (tests, and any tree mounted without it). */
export function useTutorialProgress(): TutorialProgressValue | null {
    return use(TutorialProgressContext);
}

type Entry =
    | { state: 'ready'; records: ReadonlyMap<ProgressId, TutorialRecord> }
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

const EMPLOYER_PROGRESS_IDS: readonly ProgressId[] = [...EMPLOYER_TUTORIAL_IDS, ...EMPLOYER_TOUR_IDS];

/** Whose tutorial or tour `id` is: the contract's id lists, not the route it is shown on. */
export function roleOfTutorial(id: ProgressId): TutorialRole {
    return EMPLOYER_PROGRESS_IDS.includes(id) ? 'employer' : 'worker';
}

function roleOfKey(key: string): string {
    return key.slice(0, key.indexOf(':'));
}

function flagKey(role: TutorialRole | null, account: string | null, id: ProgressId): string {
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

    // A tutorial may auto-open on this page: fetch the player now, so it
    // opens without a wait. A failure here is retried when a play asks.
    useEffect(() => {
        if (status === 'ready') loadTutorialHost().catch(() => {});
    }, [status]);

    // THE LAST CHECK before a pending play shows. It starts from a passive
    // effect, so every overlay that opened in the commit that queued the
    // play (wherever it sits in the tree) has already registered in its
    // layout phase, and it is made only once the player's chunk is in, so an
    // overlay that opened while the chunk loaded counts too. A play
    // cancelled or replaced meanwhile is left alone.
    const pending = playState.pending;
    useEffect(() => {
        if (pending === null) return;
        let current = true;
        const decide = (loaded: boolean) => {
            if (!current) return;
            const refused = plays.settle(
                (play) => !loaded || (play.mode !== 'replay' && (overlays?.isPresent() ?? false)),
            );
            if (refused) {
                refused.onRefused?.();
                // Nothing showed, so the host it was to play before opens now.
                refused.then?.();
            }
        };
        loadRendererFor(pending.id).then(
            () => decide(true),
            () => decide(false),
        );
        return () => {
            current = false;
        };
    }, [pending, plays, overlays]);

    // A host waiting on the play that just ended. This runs after the commit
    // that unmounted the player, once Modal's cleanups have released the
    // scroll lock and returned focus, so the host reads the real opener.
    useEffect(() => {
        for (const task of plays.takeAfterClose()) task();
    }, [playState, plays]);

    const hasRecord = useCallback(
        (id: ProgressId) => entry?.state === 'ready' && entry.records.has(id),
        [entry],
    );

    const isFlagged = useCallback(
        (id: ProgressId) => flagsRef.current.has(flagKey(role, account, id)) || readRecordFailed(id, account),
        [role, account],
    );

    const recordOutcome = useCallback((id: ProgressId, outcome: TutorialOutcome) => {
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

    // The settings (K1-v2). Contract stub from the hotfix base: the
    // defaults, and a save that does nothing. The settings lane reads them
    // with the progress and saves them with PATCH.
    const settings: TutorialSettings = DEFAULT_TUTORIAL_SETTINGS;
    const updateSettings = useCallback((patch: TutorialSettingsPatch) => {
        void patch;
    }, []);

    /** True when this account already has an outcome for `id`, as of this instant. */
    const recordedNow = useCallback((id: ProgressId) => {
        const { role: servingRole, loadKey: servingKey, entries: known } = latest.current;
        if (servingRole !== roleOfTutorial(id) || servingKey === null) return false;
        const current = known[servingKey];
        return current?.state === 'ready' && current.records.has(id);
    }, []);

    const onDismiss = useCallback(
        (outcome: TutorialOutcome) => {
            const ended = plays.finish();
            if (ended?.mode === 'auto') recordOutcome(ended.id, outcome);
            // An "every time" play records only the first outcome ever.
            else if (ended?.mode === 'always' && !recordedNow(ended.id)) recordOutcome(ended.id, outcome);
        },
        [plays, recordOutcome, recordedNow],
    );

    // A tutorial with nothing to show: the play ends, recording nothing.
    const onUnavailable = useCallback(() => {
        plays.finish();
    }, [plays]);

    const value = useMemo<TutorialProgressValue>(
        () => ({
            shellRole,
            role,
            status,
            hasRecord,
            isFlagged,
            recordOutcome,
            settings,
            updateSettings,
            play,
            cancel,
            isBusy,
            isOverlayPresent,
            rememberVars,
            varsFor,
        }),
        [
            shellRole,
            role,
            status,
            hasRecord,
            isFlagged,
            recordOutcome,
            settings,
            updateSettings,
            play,
            cancel,
            isBusy,
            isOverlayPresent,
            rememberVars,
            varsFor,
        ],
    );

    const active = playState.active;

    return (
        <TutorialProgressContext value={value}>
            {children}
            {active !== null ? (
                <Suspense fallback={null}>
                    {isTourId(active.id) ? (
                        <AppTourHost
                            key={active.seq}
                            id={active.id}
                            onDismiss={onDismiss}
                            onUnavailable={onUnavailable}
                        />
                    ) : (
                        <TutorialHost
                            key={active.seq}
                            id={active.id}
                            vars={active.vars}
                            onDismiss={onDismiss}
                            onUnavailable={onUnavailable}
                        />
                    )}
                </Suspense>
            ) : null}
        </TutorialProgressContext>
    );
}
