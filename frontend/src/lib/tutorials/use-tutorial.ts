'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TutorialId } from '@/lib/api/tutorials';
import {
    roleOfTutorial,
    useTutorialProgress,
    type PlayMode,
    type PlayRequest,
    type TutorialProgressValue,
    type TutorialVars,
} from './progress';
import type { TutorialHandle, UseTutorialOptions } from './types';

/**
 * The tutorial a host page plays (see `TutorialHandle` in `./types`).
 *
 * THE AUTO-OPEN RULE (K1, FE-1 §4.6, and the guide settings of K1-v2). A
 * tutorial auto-opens only when all of these hold at the moment it would open:
 *  - the progress read has succeeded, for this tutorial's role;
 *  - the account has not turned it off ("Don't show this again"): a muted
 *    tutorial never opens by itself, whatever the setting below;
 *  - EITHER the account's "every time" setting (`always_show`) is on, and
 *    then nothing else about its history counts: a record, a failed-save
 *    flag and `done` are all ignored, and it plays as an `always` play;
 *  - OR it is a first time, and plays as an `auto` play: the account has no
 *    record for it and no failed-save flag, and the host says the account
 *    has never done the task (`done === false`);
 *  - no other overlay is open, and no other tutorial is pending or up.
 *
 * "Every time" is every page view for a page's own tutorial
 * (`maybeAutoOpen`), and every press for one that plays before a host
 * (`runBeforeHost`) or inside it (`runWithHost`).
 *
 * WALKTHROUGHS. A task with a step-by-step guide plays the guide rather than
 * the slides: `maybeAutoOpen` does when the page says so (`walkthrough`), and
 * `runWithHost` always does. `runWithHost` opens the host FIRST, from the
 * caller's own handler, and then queues the guide `inHost`: the host is the
 * one overlay the guide may open over, and the guide shows once its first
 * control does. When the guide may not play, only the host opens. With
 * `replay` (Help's "Guide me through it") it plays whatever the history, and
 * records nothing.
 *
 * TIMING (ruling R4).
 *  - `maybeAutoOpen` before the read has answered is HELD, not dropped: one
 *    request per handle, judged when the read succeeds, dropped when it fails
 *    or the page goes away first.
 *  - An overlay in the way drops an ELIGIBLE request for this page view:
 *    the tutorial waits for the next eligible visit rather than queueing. A
 *    request that could not play anyway (`done` still unknown, say) does not
 *    count, so a later call on the same page can still open it.
 *  - `runBeforeHost` while the read is in flight, or whenever the tutorial
 *    may not play, opens the host at once, synchronously, from the caller's
 *    own handler. When it plays, the host opens from a post-commit effect
 *    after the tutorial has gone (see `TutorialProgressProvider`).
 *
 * THE HANDLE is one object for the life of the call site, reading the latest
 * `done` from a ref, so host effects that depend on it do not re-run.
 *
 * WITHOUT THE PROVIDER (tests, any tree outside the app layout) the handle is
 * inert: nothing opens, and `runBeforeHost` and `runWithHost` simply open the host.
 */

/**
 * How `id` may auto-play now (`always` or `auto`), or null when it may not.
 * Everything but the overlay rule, which drops a request for the page view
 * rather than for now.
 */
export function autoPlayMode(
    progress: TutorialProgressValue,
    id: TutorialId,
    done: boolean | undefined,
): Extract<PlayMode, 'always' | 'auto'> | null {
    if (progress.status !== 'ready' || progress.role !== roleOfTutorial(id) || progress.isBusy()) return null;
    const { always_show: always, muted } = progress.settings;
    if (muted.includes(id)) return null;
    if (always) return 'always';
    return done === false && !progress.hasRecord(id) && !progress.isFlagged(id) ? 'auto' : null;
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useTutorial(id: TutorialId, options: UseTutorialOptions): TutorialHandle {
    const progress = useTutorialProgress();
    const renderer: PlayRequest['renderer'] = options.walkthrough ? 'walkthrough' : undefined;

    // Latest values for the stable handle's methods.
    const latest = useRef({ progress, done: options.done, renderer });
    useIsomorphicLayoutEffect(() => {
        latest.current = { progress, done: options.done, renderer };
    });

    // Per call site: who asks (for cancelling a queued play), the one held
    // request, and whether an overlay already turned this page view down.
    const [source] = useState(() => ({}));
    const held = useRef<{ vars: TutorialVars } | null>(null);
    const declined = useRef(false);

    const handle = useMemo<TutorialHandle>(() => {
        function autoPlay(vars: TutorialVars) {
            const { progress: current, done } = latest.current;
            if (current === null || declined.current) return;
            // Only a request that could play spends the page view on the
            // overlay rule: one made while `done` is still unknown (or the
            // tutorial may not play for any other reason) leaves it for a
            // later call, such as the host's effect re-running once `done` is
            // known.
            const mode = autoPlayMode(current, id, done);
            if (mode === null) return;
            if (current.isOverlayPresent()) {
                declined.current = true;
                return;
            }
            current.play({
                id,
                vars,
                mode,
                source,
                renderer: latest.current.renderer,
                onRefused: () => {
                    declined.current = true;
                },
            });
        }

        return {
            maybeAutoOpen(vars) {
                const current = latest.current.progress;
                if (current === null) return;
                current.rememberVars(id, vars);
                if (current.status === 'loading') {
                    held.current = { vars };
                    return;
                }
                autoPlay(vars);
            },
            runBeforeHost(openHost, vars) {
                const { progress: current, done } = latest.current;
                if (current === null) {
                    openHost();
                    return;
                }
                current.rememberVars(id, vars);
                const mode = autoPlayMode(current, id, done);
                const plays =
                    mode !== null &&
                    !current.isOverlayPresent() &&
                    current.play({ id, vars, mode, then: openHost, source });
                if (!plays) {
                    // A tutorial this call site queued earlier that has not
                    // shown yet (its player still on the way, so the person
                    // pressed again) is dropped: the host opens now, once,
                    // and nothing follows it when the player arrives.
                    current.cancel(source);
                    openHost();
                }
            },
            runWithHost(openHost, vars, runOptions) {
                // The host first, synchronously: the person pressed its button.
                openHost();
                const { progress: current, done } = latest.current;
                if (current === null) return;
                current.rememberVars(id, vars);
                const mode = runOptions?.replay ? 'replay' : autoPlayMode(current, id, done);
                if (mode === null) return;
                current.play({ id, vars, mode, source, renderer: 'walkthrough', inHost: true });
            },
            replay(vars) {
                const current = latest.current.progress;
                if (current === null) return;
                current.rememberVars(id, vars);
                current.play({ id, vars: vars ?? current.varsFor(id), mode: 'replay', source });
            },
        };
    }, [id, source]);

    // A held request is judged when the read answers: played if the read
    // succeeded, dropped if it failed or nothing is being read after all.
    const status = progress?.status;
    useEffect(() => {
        if (status === undefined || status === 'loading') return;
        const request = held.current;
        held.current = null;
        if (request && status === 'ready') handle.maybeAutoOpen(request.vars);
    }, [status, handle]);

    // The page went away: its held request goes with it, and so does a play
    // it queued that has not shown yet.
    useEffect(
        () => () => {
            held.current = null;
            latest.current.progress?.cancel(source);
        },
        [source],
    );

    return handle;
}
