'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TourId } from '@/lib/api/tutorials';
import { roleOfTutorial, useTutorialProgress, type TutorialProgressValue } from './progress';

/**
 * The app tour's auto-play (K1-v2): once, for a new account, at the moment a
 * host decides the person is new. Existing accounts never get it on their
 * own; anyone can replay it from Help.
 *
 * ELIGIBLE means, at this instant: the progress read has succeeded for the
 * tour's role, the account has no outcome for the tour and no failed-save
 * flag, no tutorial is pending or up, and no other overlay is open. Whether
 * the person is "new" is the host's to decide (the employer dashboard: an
 * empty board on an account created since the tour's release; the worker
 * gate: onboarding just finished).
 */
export function mayAutoPlayTour(progress: TutorialProgressValue, id: TourId): boolean {
    return (
        progress.status === 'ready' &&
        progress.role === roleOfTutorial(id) &&
        !progress.hasRecord(id) &&
        !progress.isFlagged(id) &&
        !progress.isBusy() &&
        !progress.isOverlayPresent()
    );
}

export type AppTourHandle = {
    /**
     * Plays the tour now if it is eligible, and runs `then` once it has gone
     * (or at once, if the store turns it down at its last check). When the
     * tour is not eligible, `then` runs at once instead, synchronously.
     *
     * Asked while the progress read is still in flight, the request is HELD
     * (one per handle) and judged when the read answers; if the read fails it
     * is dropped, `then` included, since nothing auto-opens on a failed read.
     * Once the host has unmounted, a `then` still waiting on the tour is not
     * run: it belongs to a page that is gone.
     */
    playFirst(then: () => void): void;
};

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useAppTour(id: TourId): AppTourHandle {
    const progress = useTutorialProgress();

    const latest = useRef(progress);
    useIsomorphicLayoutEffect(() => {
        latest.current = progress;
    });

    // Who asks (for `cancel`), the one held request, and whether the host is
    // still on the page.
    const [source] = useState(() => ({}));
    const held = useRef<(() => void) | null>(null);
    const mounted = useRef(false);

    const handle = useMemo<AppTourHandle>(
        () => ({
            playFirst(then) {
                const current = latest.current;
                if (current === null) {
                    then();
                    return;
                }
                if (current.status === 'loading') {
                    held.current = then;
                    return;
                }
                const afterTour = () => {
                    if (mounted.current) then();
                };
                const plays =
                    mayAutoPlayTour(current, id) && current.play({ id, mode: 'auto', then: afterTour, source });
                if (!plays) then();
            },
        }),
        [id, source],
    );

    // A held request is judged when the read answers: played (or passed on to
    // `then`) if the read succeeded, dropped if it failed.
    const status = progress?.status;
    useEffect(() => {
        if (status === undefined || status === 'loading') return;
        const then = held.current;
        held.current = null;
        if (then && status !== 'failed') handle.playFirst(then);
    }, [status, handle]);

    // The host went away: a held request goes with it, and so does a tour it
    // queued that has not shown yet.
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            held.current = null;
            latest.current?.cancel(source);
        };
    }, [source]);

    return handle;
}
