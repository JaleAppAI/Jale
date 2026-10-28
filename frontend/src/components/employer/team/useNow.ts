'use client';

import { useEffect, useState } from 'react';

/**
 * The current time (ms), re-read every second while any of `deadlines` is
 * still in the future, and frozen otherwise -- so a page with no cool-down
 * running holds no timer. The interval is cleared on unmount and whenever the
 * last deadline passes.
 *
 * The first re-read is scheduled (not done during the effect) so a deadline
 * that arrives after a long idle stretch corrects a stale `now` on the next
 * tick instead of setting state inside the effect.
 */
export function useNow(deadlines: readonly number[]): number {
    const [now, setNow] = useState(() => Date.now());
    const latest = deadlines.reduce((max, d) => (d > max ? d : max), 0);
    const active = latest > now;

    useEffect(() => {
        if (!active) return;
        const tick = () => setNow(Date.now());
        const first = setTimeout(tick, 0);
        const id = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(id);
        };
    }, [active, latest]);

    return now;
}

/** Whole seconds left until `deadline` (rounded up), or 0 once it has passed. */
export function secondsLeft(deadline: number, now: number): number {
    return deadline > now ? Math.ceil((deadline - now) / 1000) : 0;
}
