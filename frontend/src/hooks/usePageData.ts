'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { classifyError, type ErrorKind } from '@/lib/api/errors';
import { useRequireAuth } from './useRequireAuth';
import { initialPageState, pageDataReducer, type PagePhase } from './pageDataReducer';

/**
 * One fetch-and-render lifecycle for an authenticated page.
 *
 * Every logged-in page in this app repeats the same five problems: wait for the
 * auth gate, fetch once a token exists, tell loading apart from empty apart
 * from failed, keep polling without letting a failed poll destroy the screen,
 * and abort cleanly on unmount. Solving them per page is how pages end up with
 * blank screens, "no results" flashes before the first response, and stale
 * responses overwriting fresh ones.
 *
 * The rules live in `pageDataReducer` (pure, tested); this hook only wires
 * effects to it. What it guarantees to a page:
 *
 *  - The fetcher NEVER runs without a token. Until AuthContext settles and an
 *    id token exists, the phase is 'auth' and nothing is requested.
 *  - Every request is numbered and every response is fenced by that number, so
 *    an overtaken response cannot overwrite a newer one.
 *  - A background refresh (poll, or an explicit `refresh()`) can only ever
 *    ADD -- newer data, or a `refreshError` footnote. It cannot move the phase
 *    or clear `data`. A page the user is reading stays readable.
 *  - Every in-flight request is aborted on unmount and on a deps change.
 *  - The legal wall is a redirect, not an error: it stores the return URL and
 *    holds 'loading' so the page shows its skeleton until the wall takes over,
 *    instead of flashing an error the user cannot act on.
 *
 * 401s should not reach here at all -- `apiFetch` refreshes the token once and
 * redirects to sign-in if that fails. One that surfaces anyway still classifies
 * as 'unauthorized' and renders like any other error rather than blanking.
 */

export type UsePageDataOptions<T> = {
    /**
     * Loads the page's data. Receives a guaranteed-non-empty token and a signal
     * that aborts on unmount / deps change. Must reject on failure -- returning
     * a sentinel would make the page render a "success" it did not have.
     */
    fetcher: (ctx: { token: string; signal: AbortSignal }) => Promise<T>;
    /** Redirect an unauthenticated visitor to sign-in. Default `true`. */
    requireAuth?: boolean;
    /** Where the legal wall returns to. Defaults to the current pathname. */
    legalReturnUrl?: string;
    /** Lets the page distinguish "loaded, but nothing in it" from "loaded". */
    isEmpty?: (data: T) => boolean;
    /** Background poll interval in ms. Failures only ever set `refreshError`. */
    pollMs?: number;
    /** Values that invalidate the data. A change resets and reloads. */
    deps?: ReadonlyArray<unknown>;
};

export type UsePageDataResult<T> = {
    phase: PagePhase;
    data: T | null;
    /** True only when data is loaded AND `isEmpty` says it is empty. */
    empty: boolean;
    errorKind: ErrorKind | null;
    refreshing: boolean;
    refreshError: ErrorKind | null;
    /** Full reload: back to a skeleton, then a fresh request. */
    retry: () => void;
    /** Background reload: the page stays rendered throughout. */
    refresh: () => Promise<void>;
    /** Local edit of loaded data (e.g. after an optimistic mutation). */
    setData: (updater: T | ((prev: T) => T)) => void;
};

const EMPTY_DEPS: ReadonlyArray<unknown> = [];

function sameDeps(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (!Object.is(a[i], b[i])) return false;
    }
    return true;
}

/**
 * A number that increments whenever `deps` changes by value, so callers can
 * pass a fresh inline array every render without retriggering anything.
 *
 * The ref write during render is the standard derive-from-props pattern: it is
 * idempotent (a second render with the same deps compares equal and returns the
 * same token), so StrictMode's double invocation is a no-op.
 */
function useDepsToken(deps: ReadonlyArray<unknown>): number {
    const ref = useRef<{ deps: ReadonlyArray<unknown>; token: number }>({ deps, token: 0 });
    if (!sameDeps(ref.current.deps, deps)) {
        ref.current = { deps, token: ref.current.token + 1 };
    }
    return ref.current.token;
}

export function usePageData<T>(options: UsePageDataOptions<T>): UsePageDataResult<T> {
    const {
        fetcher,
        requireAuth = true,
        legalReturnUrl,
        isEmpty,
        pollMs,
        deps = EMPTY_DEPS,
    } = options;

    const { idToken, isLoading } = useAuth();
    const pathname = usePathname();
    // Called unconditionally (hook rules); `enabled` is what actually arms the
    // sign-in redirect. `handleLegalWall` is wanted either way -- reusing it is
    // what keeps the return-URL contract identical to every hand-rolled page.
    const { handleLegalWall } = useRequireAuth({ enabled: requireAuth });

    // Instantiated once for this T so `dispatch` is typed to PageEvent<T>.
    const reducer = pageDataReducer<T>;
    const [state, dispatch] = useReducer(reducer, undefined, initialPageState<T>);

    // Bumped by retry() to re-run the load effect without changing deps.
    const [reloadToken, setReloadToken] = useState(0);

    const depsToken = useDepsToken(deps);

    // Latest-value mirrors. These are read inside async work and effects that
    // must NOT re-run when a caller passes a new inline function each render.
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;
    const isEmptyRef = useRef(isEmpty);
    isEmptyRef.current = isEmpty;
    const legalWallRef = useRef(handleLegalWall);
    legalWallRef.current = handleLegalWall;
    const returnUrlRef = useRef(legalReturnUrl ?? pathname);
    returnUrlRef.current = legalReturnUrl ?? pathname;
    const idTokenRef = useRef(idToken);
    idTokenRef.current = idToken;
    const stateRef = useRef(state);
    stateRef.current = state;

    const requestCounterRef = useRef(0);
    /** Controller for the current background refresh, so it can be superseded. */
    const refreshControllerRef = useRef<AbortController | null>(null);

    /**
     * The single request path. `mode` picks which half of the reducer's event
     * vocabulary is used, which is what makes a refresh structurally unable to
     * blank the page.
     */
    const runRequest = useCallback(async (mode: 'load' | 'refresh', signal: AbortSignal) => {
        const token = idTokenRef.current;
        // Belt and braces: the gate below already guarantees this.
        if (!token) return;

        const requestId = (requestCounterRef.current += 1);
        dispatch(
            mode === 'load'
                ? { type: 'LOAD_START', requestId }
                : { type: 'REFRESH_START', requestId },
        );

        try {
            const data = await fetcherRef.current({ token, signal });
            if (signal.aborted) return;
            dispatch(
                mode === 'load'
                    ? { type: 'LOAD_SUCCESS', requestId, data }
                    : { type: 'REFRESH_SUCCESS', requestId, data },
            );
        } catch (err) {
            // An abort is not a failure; it means we no longer want the answer.
            if (signal.aborted) return;

            const { kind } = classifyError(err);

            if (kind === 'legal_wall') {
                // Deliberately dispatches nothing: the phase holds where it is
                // (skeleton for a load, rendered page for a refresh) while the
                // redirect to /legal/accept takes over. Showing an error here
                // would be a screen the user cannot act on.
                try {
                    legalWallRef.current(err, returnUrlRef.current);
                } catch {
                    // handleLegalWall rethrows anything that is not a legal
                    // wall; classifyError says this one is, so this is
                    // unreachable in practice. Swallowing beats an unhandled
                    // rejection if the two ever disagree.
                }
                return;
            }

            dispatch(
                mode === 'load'
                    ? { type: 'LOAD_ERROR', requestId, kind }
                    : { type: 'REFRESH_ERROR', requestId, kind },
            );
        }
    }, []);

    // The auth gate. Nothing is requested until AuthContext has settled AND a
    // token exists. `idToken` is read through a ref inside the effect so that a
    // silent token refresh mid-session does not reload the whole page.
    const gateOpen = !isLoading && Boolean(idToken);

    useEffect(() => {
        if (!gateOpen) {
            // Session ended, or the gate never opened: forget everything and
            // wait at 'auth'. The reducer no-ops when already at rest.
            dispatch({ type: 'RESET' });
            return;
        }

        // Deps changed (or this is the first run): drop the old data before
        // asking for the new. Batched with LOAD_START, so 'auth' is passed
        // through rather than rendered.
        dispatch({ type: 'RESET' });
        dispatch({ type: 'TOKEN_READY' });

        const controller = new AbortController();
        void runRequest('load', controller.signal);

        return () => controller.abort();
    }, [gateOpen, depsToken, reloadToken, runRequest]);

    // Abort any in-flight background refresh when the page goes away.
    useEffect(() => () => refreshControllerRef.current?.abort(), []);

    const refresh = useCallback(async () => {
        if (!idTokenRef.current) return;
        // Only ever refresh over rendered data; the reducer would reject a
        // REFRESH_START anywhere else, and firing one would waste a request.
        if (stateRef.current.phase !== 'ready') return;

        refreshControllerRef.current?.abort();
        const controller = new AbortController();
        refreshControllerRef.current = controller;
        await runRequest('refresh', controller.signal);
    }, [runRequest]);

    // Background poll. Ticks are skipped while the tab is hidden: a phone in a
    // pocket should not spend battery and quota re-fetching a page nobody is
    // looking at. The next visible tick catches up.
    useEffect(() => {
        if (!pollMs || pollMs <= 0) return;
        if (state.phase !== 'ready') return;

        const id = window.setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void refresh();
        }, pollMs);

        return () => window.clearInterval(id);
    }, [pollMs, state.phase, refresh]);

    const retry = useCallback(() => {
        setReloadToken((n) => n + 1);
    }, []);

    const setData = useCallback((updater: T | ((prev: T) => T)) => {
        const prev = stateRef.current.data;
        // Nothing on screen to edit; the reducer would reject it anyway.
        if (prev === null) return;
        const next =
            typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;
        dispatch({ type: 'SET_DATA', data: next });
    }, []);

    // `empty` is a property of loaded data only. Reporting it while loading is
    // exactly the "no results" flash this hook exists to prevent.
    // Deliberately NOT memoized. `isEmpty` is read through a ref (so a caller
    // can pass a fresh inline closure every render without retriggering the
    // fetch effects), and a ref read is invisible to a dependency array: a
    // predicate that closes over component state — `items.filter(byTab).length
    // === 0` is the motivating case — would keep reporting the answer it gave
    // when `data` last changed, and an emptied tab would render a stale list.
    // The predicate is a cheap array check; recomputing it per render is
    // cheaper than the class of bug memoizing it invites.
    const empty =
        state.phase === 'ready' && state.data !== null && isEmptyRef.current
            ? isEmptyRef.current(state.data)
            : false;

    return {
        phase: state.phase,
        data: state.data,
        empty,
        errorKind: state.errorKind,
        refreshing: state.refreshing,
        refreshError: state.refreshError,
        retry,
        refresh,
        setData,
    };
}
