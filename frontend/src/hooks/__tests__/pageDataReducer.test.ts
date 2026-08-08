import { describe, expect, it } from 'vitest';
import {
    initialPageState,
    pageDataReducer,
    type PageEvent,
    type PagePhase,
    type PageState,
} from '../pageDataReducer';
import type { ErrorKind } from '@/lib/api/errors';

/**
 * The reducer is where "a page cannot lie to the user" is actually enforced,
 * so each guarantee it makes gets its own test rather than being implied by a
 * happy-path walkthrough.
 */

type Data = { items: string[] };

const A: Data = { items: ['a'] };
const B: Data = { items: ['b'] };

const ALL_PHASES: readonly PagePhase[] = ['auth', 'loading', 'ready', 'error'];

const ALL_KINDS: readonly ErrorKind[] = [
    'offline',
    'timeout',
    'unauthorized',
    'forbidden',
    'not_found',
    'gone',
    'conflict',
    'validation',
    'rate_limited',
    'server',
    'legal_wall',
    'unknown',
];

/** Reduce a sequence of events from the initial state. */
function run(...events: PageEvent<Data>[]): PageState<Data> {
    return events.reduce<PageState<Data>>(
        (state, event) => pageDataReducer(state, event),
        initialPageState<Data>(),
    );
}

/** A state parked in 'ready' with `data` and the given requestId on record. */
function readyState(requestId = 1, data: Data = A): PageState<Data> {
    return run(
        { type: 'TOKEN_READY' },
        { type: 'LOAD_START', requestId },
        { type: 'LOAD_SUCCESS', requestId, data },
    );
}

/** Hand-built state, for exhaustive per-phase probing. */
function stateWith(overrides: Partial<PageState<Data>>): PageState<Data> {
    return { ...initialPageState<Data>(), ...overrides };
}

describe('pageDataReducer', () => {
    describe('the happy path', () => {
        it('starts in auth with nothing loaded', () => {
            expect(initialPageState<Data>()).toEqual({
                phase: 'auth',
                data: null,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                requestId: 0,
            });
        });

        it('walks auth -> loading -> ready and exposes the loaded data', () => {
            const afterGate = pageDataReducer(initialPageState<Data>(), { type: 'TOKEN_READY' });
            expect(afterGate.phase).toBe('loading');

            const afterStart = pageDataReducer(afterGate, { type: 'LOAD_START', requestId: 1 });
            expect(afterStart.phase).toBe('loading');
            expect(afterStart.data).toBeNull();

            const afterSuccess = pageDataReducer(afterStart, { type: 'LOAD_SUCCESS', requestId: 1, data: A });
            expect(afterSuccess.phase).toBe('ready');
            expect(afterSuccess.data).toBe(A);
            expect(afterSuccess.errorKind).toBeNull();
        });

        it('walks loading -> error and records the kind', () => {
            const errored = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_ERROR', requestId: 1, kind: 'server' },
            );
            expect(errored.phase).toBe('error');
            expect(errored.errorKind).toBe('server');
            expect(errored.data).toBeNull();
        });

        it('drops stale data when a new foreground load starts', () => {
            const reloading = pageDataReducer(readyState(1), { type: 'LOAD_START', requestId: 2 });
            expect(reloading.phase).toBe('loading');
            expect(reloading.data).toBeNull();
            expect(reloading.requestId).toBe(2);
        });

        it('leaves TOKEN_READY inert once past the gate', () => {
            const ready = readyState(1);
            expect(pageDataReducer(ready, { type: 'TOKEN_READY' })).toBe(ready);

            const errored = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_ERROR', requestId: 1, kind: 'offline' },
            );
            expect(pageDataReducer(errored, { type: 'TOKEN_READY' })).toBe(errored);
        });
    });

    // GUARANTEE 1
    describe('stale requestId events are no-ops', () => {
        it('ignores a LOAD_SUCCESS from a superseded request', () => {
            const loading = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_START', requestId: 2 },
            );
            expect(pageDataReducer(loading, { type: 'LOAD_SUCCESS', requestId: 1, data: A })).toBe(loading);
        });

        it('ignores a LOAD_ERROR from a superseded request', () => {
            const loading = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_START', requestId: 2 },
            );
            expect(pageDataReducer(loading, { type: 'LOAD_ERROR', requestId: 1, kind: 'server' })).toBe(loading);
        });

        it('does not let a slow first response overwrite a newer one', () => {
            // Request 1 starts, request 2 starts and WINS, then request 1 finally
            // answers with older data. The screen must keep request 2's answer.
            const settled = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_START', requestId: 2 },
                { type: 'LOAD_SUCCESS', requestId: 2, data: B },
                { type: 'LOAD_SUCCESS', requestId: 1, data: A },
            );
            expect(settled.data).toBe(B);
        });

        it('ignores stale REFRESH_SUCCESS and REFRESH_ERROR', () => {
            const refreshing = pageDataReducer(readyState(1), { type: 'REFRESH_START', requestId: 2 });
            expect(pageDataReducer(refreshing, { type: 'REFRESH_SUCCESS', requestId: 1, data: B })).toBe(refreshing);
            expect(pageDataReducer(refreshing, { type: 'REFRESH_ERROR', requestId: 1, kind: 'offline' })).toBe(refreshing);
        });

        it('ignores completions that arrive before any request was recorded', () => {
            const gated = pageDataReducer(initialPageState<Data>(), { type: 'TOKEN_READY' });
            // requestId 0 is the initial value, so a completion claiming id 7
            // belongs to nothing this state knows about.
            expect(pageDataReducer(gated, { type: 'LOAD_SUCCESS', requestId: 7, data: A })).toBe(gated);
        });
    });

    // GUARANTEE 2 -- the one that protects a page the user is already reading.
    describe('REFRESH_ERROR can never change phase or null data', () => {
        it('leaves a ready page fully intact', () => {
            const refreshing = pageDataReducer(readyState(1), { type: 'REFRESH_START', requestId: 2 });
            const failed = pageDataReducer(refreshing, { type: 'REFRESH_ERROR', requestId: 2, kind: 'offline' });

            expect(failed.phase).toBe('ready');
            expect(failed.data).toBe(A);
            expect(failed.errorKind).toBeNull();
            expect(failed.refreshing).toBe(false);
            expect(failed.refreshError).toBe('offline');
        });

        it('holds phase and data for every phase and every error kind', () => {
            for (const phase of ALL_PHASES) {
                for (const kind of ALL_KINDS) {
                    const before = stateWith({ phase, data: A, requestId: 3, refreshing: true });
                    const after = pageDataReducer(before, { type: 'REFRESH_ERROR', requestId: 3, kind });

                    expect(after.phase).toBe(phase);
                    expect(after.data).toBe(A);
                    expect(after.refreshing).toBe(false);
                    expect(after.refreshError).toBe(kind);
                }
            }
        });

        it('does not resurrect an errorKind on a ready page', () => {
            const refreshing = pageDataReducer(readyState(1), { type: 'REFRESH_START', requestId: 2 });
            const failed = pageDataReducer(refreshing, { type: 'REFRESH_ERROR', requestId: 2, kind: 'server' });
            expect(failed.errorKind).toBeNull();
        });

        it('survives a run of consecutive failed refreshes', () => {
            let state = readyState(1);
            for (let id = 2; id <= 6; id += 1) {
                state = pageDataReducer(state, { type: 'REFRESH_START', requestId: id });
                state = pageDataReducer(state, { type: 'REFRESH_ERROR', requestId: id, kind: 'timeout' });
            }
            expect(state.phase).toBe('ready');
            expect(state.data).toBe(A);
            expect(state.refreshError).toBe('timeout');
        });
    });

    // GUARANTEE 3
    describe("LOAD_ERROR only lands from 'loading'", () => {
        it('is accepted from loading', () => {
            const loading = run({ type: 'TOKEN_READY' }, { type: 'LOAD_START', requestId: 1 });
            expect(pageDataReducer(loading, { type: 'LOAD_ERROR', requestId: 1, kind: 'server' }).phase).toBe('error');
        });

        it('is rejected from every other phase, even with a matching requestId', () => {
            for (const phase of ALL_PHASES.filter((p) => p !== 'loading')) {
                const before = stateWith({ phase, data: A, requestId: 4 });
                expect(pageDataReducer(before, { type: 'LOAD_ERROR', requestId: 4, kind: 'server' })).toBe(before);
            }
        });

        it('cannot turn a rendered page into an error screen', () => {
            const ready = readyState(9);
            const after = pageDataReducer(ready, { type: 'LOAD_ERROR', requestId: 9, kind: 'not_found' });
            expect(after).toBe(ready);
            expect(after.data).toBe(A);
        });
    });

    describe("LOAD_SUCCESS only lands from 'loading'", () => {
        it('is rejected from every other phase, even with a matching requestId', () => {
            for (const phase of ALL_PHASES.filter((p) => p !== 'loading')) {
                const before = stateWith({ phase, data: A, requestId: 4 });
                expect(pageDataReducer(before, { type: 'LOAD_SUCCESS', requestId: 4, data: B })).toBe(before);
            }
        });
    });

    // GUARANTEE 4
    describe("SET_DATA only lands from 'ready'", () => {
        it('replaces data on a ready page without disturbing anything else', () => {
            const ready = readyState(1);
            const after = pageDataReducer(ready, { type: 'SET_DATA', data: B });
            expect(after.phase).toBe('ready');
            expect(after.data).toBe(B);
            expect(after.requestId).toBe(ready.requestId);
            expect(after.refreshing).toBe(false);
        });

        it('is rejected from auth, loading and error', () => {
            for (const phase of ALL_PHASES.filter((p) => p !== 'ready')) {
                const before = stateWith({ phase, requestId: 2 });
                expect(pageDataReducer(before, { type: 'SET_DATA', data: B })).toBe(before);
            }
        });

        it('cannot smuggle data into a loading page', () => {
            const loading = run({ type: 'TOKEN_READY' }, { type: 'LOAD_START', requestId: 1 });
            expect(pageDataReducer(loading, { type: 'SET_DATA', data: B }).data).toBeNull();
        });
    });

    // GUARANTEE 5 -- documented choice: RESET returns to 'auth', so the token
    // gate is re-checked before anything is fetched again.
    describe('RESET returns to auth', () => {
        it('clears data, errors and the refresh flags from a ready page', () => {
            const busy = pageDataReducer(readyState(1), { type: 'REFRESH_START', requestId: 2 });
            const after = pageDataReducer(busy, { type: 'RESET' });

            expect(after.phase).toBe('auth');
            expect(after.data).toBeNull();
            expect(after.errorKind).toBeNull();
            expect(after.refreshing).toBe(false);
            expect(after.refreshError).toBeNull();
        });

        it('clears an error page', () => {
            const errored = run(
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 1 },
                { type: 'LOAD_ERROR', requestId: 1, kind: 'forbidden' },
            );
            const after = pageDataReducer(errored, { type: 'RESET' });
            expect(after.phase).toBe('auth');
            expect(after.errorKind).toBeNull();
        });

        it('preserves requestId so in-flight responses stay fenced out', () => {
            const ready = readyState(5);
            const after = pageDataReducer(ready, { type: 'RESET' });
            expect(after.requestId).toBe(5);
            // The in-flight request 5 answering after the reset must not be
            // treated as the answer to whatever comes next.
            expect(pageDataReducer(after, { type: 'LOAD_SUCCESS', requestId: 5, data: B })).toBe(after);
        });

        it('is identity-stable when already at rest, so it cannot spin', () => {
            const initial = initialPageState<Data>();
            expect(pageDataReducer(initial, { type: 'RESET' })).toBe(initial);
        });
    });

    // GUARANTEE 6
    describe('REFRESH_SUCCESS clears refreshError', () => {
        it('drops the stale note once a refresh finally lands', () => {
            let state = readyState(1);
            state = pageDataReducer(state, { type: 'REFRESH_START', requestId: 2 });
            state = pageDataReducer(state, { type: 'REFRESH_ERROR', requestId: 2, kind: 'offline' });
            expect(state.refreshError).toBe('offline');

            state = pageDataReducer(state, { type: 'REFRESH_START', requestId: 3 });
            // Still showing the note while the retry is in flight.
            expect(state.refreshError).toBe('offline');
            expect(state.refreshing).toBe(true);

            state = pageDataReducer(state, { type: 'REFRESH_SUCCESS', requestId: 3, data: B });
            expect(state.refreshError).toBeNull();
            expect(state.refreshing).toBe(false);
            expect(state.data).toBe(B);
            expect(state.phase).toBe('ready');
        });

        it('keeps the page in ready throughout a refresh cycle', () => {
            let state = readyState(1);
            state = pageDataReducer(state, { type: 'REFRESH_START', requestId: 2 });
            expect(state.phase).toBe('ready');
            expect(state.data).toBe(A);
            state = pageDataReducer(state, { type: 'REFRESH_SUCCESS', requestId: 2, data: B });
            expect(state.phase).toBe('ready');
        });
    });

    describe('REFRESH_START is confined to ready', () => {
        it('is ignored outside ready, so nothing can fake a background refresh', () => {
            for (const phase of ALL_PHASES.filter((p) => p !== 'ready')) {
                const before = stateWith({ phase, requestId: 1 });
                expect(pageDataReducer(before, { type: 'REFRESH_START', requestId: 2 })).toBe(before);
            }
        });

        it('takes ownership of the requestId when accepted', () => {
            const after = pageDataReducer(readyState(1), { type: 'REFRESH_START', requestId: 2 });
            expect(after.requestId).toBe(2);
            expect(after.refreshing).toBe(true);
        });
    });

    describe('purity', () => {
        it('never mutates the state it is given', () => {
            const before = readyState(1);
            const snapshot = JSON.parse(JSON.stringify(before));
            const events: PageEvent<Data>[] = [
                { type: 'TOKEN_READY' },
                { type: 'LOAD_START', requestId: 2 },
                { type: 'LOAD_SUCCESS', requestId: 2, data: B },
                { type: 'LOAD_ERROR', requestId: 2, kind: 'server' },
                { type: 'REFRESH_START', requestId: 3 },
                { type: 'REFRESH_SUCCESS', requestId: 3, data: B },
                { type: 'REFRESH_ERROR', requestId: 3, kind: 'timeout' },
                { type: 'SET_DATA', data: B },
                { type: 'RESET' },
            ];
            for (const event of events) pageDataReducer(before, event);
            expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
        });

        it('leaves an unknown event untouched', () => {
            const ready = readyState(1);
            expect(pageDataReducer(ready, { type: 'NOT_AN_EVENT' } as unknown as PageEvent<Data>)).toBe(ready);
        });
    });
});
