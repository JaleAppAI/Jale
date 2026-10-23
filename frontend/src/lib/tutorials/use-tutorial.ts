'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TutorialId } from '@/lib/api/tutorials';
import { roleOfTutorial, useTutorialProgress, type TutorialProgressValue, type TutorialVars } from './progress';
import type { TutorialHandle, UseTutorialOptions } from './types';

/**
 * The tutorial a host page plays (see `TutorialHandle` in `./types`).
 *
 * THE AUTO-OPEN RULE (K1, FE-1 §4.6). A tutorial auto-opens only when all of
 * these hold at the moment it would open:
 *  - the progress read has succeeded, for this tutorial's role;
 *  - the account has no record for it and no failed-save flag;
 *  - the host says the account has never done the task (`done === false`);
 *  - no other overlay is open, and no other tutorial is pending or up.
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
 * inert: nothing opens, and `runBeforeHost` simply opens the host.
 */

/** Everything but the overlay rule, which drops a request for the page view rather than for now. */
function mayAutoPlay(progress: TutorialProgressValue, id: TutorialId, done: boolean | undefined): boolean {
    return (
        progress.status === 'ready' &&
        progress.role === roleOfTutorial(id) &&
        done === false &&
        !progress.hasRecord(id) &&
        !progress.isFlagged(id) &&
        !progress.isBusy()
    );
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useTutorial(id: TutorialId, options: UseTutorialOptions): TutorialHandle {
    const progress = useTutorialProgress();

    // Latest values for the stable handle's methods.
    const latest = useRef({ progress, done: options.done });
    useIsomorphicLayoutEffect(() => {
        latest.current = { progress, done: options.done };
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
            if (!mayAutoPlay(current, id, done)) return;
            if (current.isOverlayPresent()) {
                declined.current = true;
                return;
            }
            current.play({
                id,
                vars,
                mode: 'auto',
                source,
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
                const plays =
                    mayAutoPlay(current, id, done) &&
                    !current.isOverlayPresent() &&
                    current.play({ id, vars, mode: 'auto', then: openHost, source });
                if (!plays) openHost();
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
