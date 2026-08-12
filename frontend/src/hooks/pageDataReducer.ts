import type { ErrorKind } from '@/lib/api/errors';

/**
 * The state machine behind `usePageData`.
 *
 * Split out from the hook and kept pure so the rules below are testable in the
 * node-env vitest suite with no React, no DOM and no network. The hook is then
 * only responsible for wiring effects to it -- every decision about what a page
 * is allowed to show lives here.
 *
 * The four phases are exhaustive and mutually exclusive:
 *
 *   auth     - the auth gate has not opened yet (AuthContext still settling, or
 *              no id token). Nothing has been requested. Pages render their
 *              skeleton.
 *   loading  - a foreground request is in flight and there is no data to show.
 *   ready    - `data` is non-null and renderable. It STAYS renderable: nothing
 *              short of an explicit reload can take it away.
 *   error    - the foreground request failed and there is nothing to show.
 *
 * The load path (LOAD_*) and the refresh path (REFRESH_*) exist separately
 * because they mean different things to a user. A load is "I have nothing, I am
 * fetching"; its failure is the whole screen. A refresh is "I have something,
 * I am checking for newer"; its failure must never take the screen away -- a
 * poll tick that fails while the user reads a page they already have is a
 * footnote, not a page state. That is why REFRESH_ERROR is structurally
 * incapable of touching `phase` or `data`.
 *
 * Every completion event carries the `requestId` of the request that produced
 * it and is discarded unless it matches the request currently on record. This
 * is what makes overlapping requests safe: a slow response that lands after a
 * newer request started cannot overwrite the newer one's result.
 */

export type PagePhase = 'auth' | 'loading' | 'ready' | 'error';

export type PageState<T> = {
    phase: PagePhase;
    data: T | null;
    /** Why the foreground load failed. Non-null only in phase 'error'. */
    errorKind: ErrorKind | null;
    /** A background refresh is in flight. Orthogonal to `phase`. */
    refreshing: boolean;
    /** Why the last background refresh failed. Never affects `phase`/`data`. */
    refreshError: ErrorKind | null;
    /** The request whose completion events this state will accept. */
    requestId: number;
};

export type PageEvent<T> =
    /** The auth gate opened: a token exists and a load may now start. */
    | { type: 'TOKEN_READY' }
    | { type: 'LOAD_START'; requestId: number }
    | { type: 'LOAD_SUCCESS'; requestId: number; data: T }
    | { type: 'LOAD_ERROR'; requestId: number; kind: ErrorKind }
    | { type: 'REFRESH_START'; requestId: number }
    | { type: 'REFRESH_SUCCESS'; requestId: number; data: T }
    | { type: 'REFRESH_ERROR'; requestId: number; kind: ErrorKind }
    /** Local edit of data already on screen (optimistic update after a mutation). */
    | { type: 'SET_DATA'; data: T }
    /** Deps changed or the session ended: forget everything and re-gate. */
    | { type: 'RESET' };

export function initialPageState<T>(): PageState<T> {
    return {
        phase: 'auth',
        data: null,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        requestId: 0,
    };
}

/** True when `s` is already at rest in the initial shape (ignoring requestId). */
function isAtRest<T>(s: PageState<T>): boolean {
    return (
        s.phase === 'auth' &&
        s.data === null &&
        s.errorKind === null &&
        !s.refreshing &&
        s.refreshError === null
    );
}

export function pageDataReducer<T>(s: PageState<T>, e: PageEvent<T>): PageState<T> {
    switch (e.type) {
        /**
         * Opens the gate. Only meaningful from 'auth'; from anywhere else a
         * token becoming available again (e.g. after a silent refresh) must not
         * knock a rendered page back into a loading state.
         */
        case 'TOKEN_READY':
            return s.phase === 'auth' ? { ...s, phase: 'loading' } : s;

        /**
         * Begins a foreground load. `data` is dropped deliberately: phase
         * 'loading' means "there is nothing to show", so keeping stale data
         * around would let a caller render content under a skeleton.
         */
        case 'LOAD_START':
            return {
                phase: 'loading',
                data: null,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                requestId: e.requestId,
            };

        // Only the load currently on record can resolve, and only into the
        // phase that started it.
        case 'LOAD_SUCCESS':
            if (e.requestId !== s.requestId || s.phase !== 'loading') return s;
            return {
                ...s,
                phase: 'ready',
                data: e.data,
                errorKind: null,
                refreshing: false,
                refreshError: null,
            };

        /**
         * A foreground failure is only ever a foreground failure. Reaching
         * 'error' from 'ready' would mean a rendered page could be replaced by
         * an error screen; the refresh path exists precisely so that cannot
         * happen.
         */
        case 'LOAD_ERROR':
            if (e.requestId !== s.requestId || s.phase !== 'loading') return s;
            return {
                ...s,
                phase: 'error',
                data: null,
                errorKind: e.kind,
                refreshing: false,
                refreshError: null,
            };

        /**
         * Background refreshes only make sense over rendered data. Note this
         * does NOT clear `refreshError`: while a poll keeps failing, the "still
         * trying" note should stay put rather than blink out on every tick.
         */
        case 'REFRESH_START':
            if (s.phase !== 'ready') return s;
            return { ...s, refreshing: true, requestId: e.requestId };

        case 'REFRESH_SUCCESS':
            if (e.requestId !== s.requestId || s.phase !== 'ready') return s;
            return { ...s, data: e.data, refreshing: false, refreshError: null };

        /**
         * THE load-bearing guarantee of this reducer: a failed background
         * refresh writes `refreshing` and `refreshError` and nothing else. It
         * cannot change `phase` and cannot null `data`, so a page the user is
         * reading can never be yanked out from under them by a poll tick.
         * There is deliberately no phase guard -- the property has to hold
         * unconditionally, not only where the hook currently dispatches it.
         */
        case 'REFRESH_ERROR':
            if (e.requestId !== s.requestId) return s;
            return { ...s, refreshing: false, refreshError: e.kind };

        /**
         * A local edit of what is already on screen. Rejected outside 'ready'
         * because there is nothing to edit: accepting it would create the
         * contradictory `phase: 'loading'` + non-null `data`.
         */
        case 'SET_DATA':
            if (s.phase !== 'ready') return s;
            return { ...s, data: e.data };

        /**
         * Back to 'auth', not 'loading': a reset follows a deps change or a
         * session ending, and in both cases the token has to be re-checked
         * before anything is fetched. Re-entering through the gate is what
         * guarantees the fetcher never runs without one.
         *
         * `requestId` is deliberately PRESERVED. Rewinding it could let an
         * in-flight response from before the reset match a later request's id
         * and be accepted as that request's result.
         */
        case 'RESET':
            // Identity-stable when already at rest, so a caller that resets on
            // every render of a signed-out page cannot spin.
            if (isAtRest(s)) return s;
            return { ...initialPageState<T>(), requestId: s.requestId };

        default:
            return s;
    }
}
