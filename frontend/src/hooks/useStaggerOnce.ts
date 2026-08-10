'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AnimationEvent } from 'react';

/**
 * Runs a container's `.anim-stagger` cascade for the FIRST arrival of its
 * children, and never again.
 *
 * The cascade is a first-impression effect: it says "this just arrived". Any
 * later redraw of the same container replays it, because `.anim-stagger > *`
 * animates whatever children exist at the time -- a client-side search or
 * status filter that re-inserts rows, a background `refresh()`, a poll tick, a
 * `retry()`. A list that re-cascades on every keystroke reads as a page that
 * keeps reloading itself.
 *
 * Gating on "has anything been refetched yet" cannot express that: a filter
 * that runs entirely over already-loaded data never touches the fetch layer,
 * and that is the most common way the cascade replays.
 *
 * So the gate closes on the cascade's OWN completion, which is the only moment
 * that is both late enough and early enough:
 *
 *  - Late enough. Removing `.anim-stagger` CANCELS the animations it is
 *    currently driving: the children lose their `animation-name` and jump to
 *    their end state in that same frame. Measured in Chrome against this app's
 *    keyframes, an 8-row list one frame after its first paint has row 8 at
 *    opacity 0 with one running animation; remove the class and row 8 is at
 *    opacity 1 with none. A gate that closed on the first loaded paint -- an
 *    effect, one frame in -- would therefore abort the very cascade it exists
 *    to protect, on every page, every time.
 *  - Early enough. Nothing can be inserted between the last child finishing and
 *    the class coming off, so no child that arrives later ever animates.
 *
 * Boolean STATE, not a ref: a ref write does not re-render, so the class would
 * come off at whatever unrelated re-render happened to land next -- possibly
 * mid-cascade, possibly never. State makes the removal a single deterministic
 * commit, immediately after the last child's `animationend`.
 *
 * The failure mode is deliberately the harmless one. If the completion event
 * never arrives -- the container unmounted mid-cascade, or
 * `prefers-reduced-motion: reduce` turned the animation off and there was
 * nothing to complete -- the class simply stays, which is exactly the state
 * every one of these lists was in before this hook existed, and under reduced
 * motion it drives nothing at all. A missed event costs one extra cascade, not
 * a broken page.
 *
 * Usage: put `staggerClass` and `onCascadeEnd` on the SAME element -- the one
 * whose direct children should cascade.
 *
 *     const { staggerClass, onCascadeEnd } = useStaggerOnce();
 *     <ul className={[base, staggerClass].filter(Boolean).join(' ')}
 *         onAnimationEnd={onCascadeEnd}>
 */
export function useStaggerOnce(resetKey?: unknown) {
    const [spent, setSpent] = useState(false);

    /*
     * A changed `resetKey` means the container is about to show a genuinely
     * different subject (a different job, say), so the next paint is a first
     * arrival again and has earned its own cascade. Callers with a single
     * subject pass nothing and this runs once, at mount, as a no-op.
     */
    useEffect(() => {
        setSpent(false);
    }, [resetKey]);

    const onCascadeEnd = useCallback((event: AnimationEvent<Element>) => {
        /*
         * Every child shares one duration and carries a delay that only grows
         * with its position, so the last child is always the last to finish:
         * its `animationend` IS the end of the cascade. Matching on it also
         * discards the `animationend`s that bubble up from animated elements
         * nested inside the children.
         */
        const last = event.currentTarget.lastElementChild;
        if (last === null || event.target !== last) return;
        setSpent(true);
    }, []);

    return {
        /** `'anim-stagger'` until the first cascade finishes, then `''`. */
        staggerClass: spent ? '' : 'anim-stagger',
        /** Attach as `onAnimationEnd` on the element carrying `staggerClass`. */
        onCascadeEnd,
    };
}
