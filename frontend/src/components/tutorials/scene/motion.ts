'use client';

import { createContext, use, useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * The motion core shared by every animated scene piece.
 *
 * THE RULE THE WHOLE KIT FOLLOWS (the `ConfettiBurst` rule): a piece's markup
 * alone is its FINAL frame, and motion is a Web Animation layered on top. So a
 * still stage, a person who asked for reduced motion, a runtime with no
 * `Element.animate` (jsdom, older mobile Safari) and a bundle that never
 * arrives all show the same finished picture, and no piece needs a second,
 * hand-written "reduced" layout.
 *
 * Every animation in a slide plays ONCE, on one shared clock: the same
 * duration, started in the same effect flush when the slide mounts, so a
 * "step 2" piece always lands after a "step 1" piece. Then the animation ends
 * and the markup, the final frame, stays: nothing keeps moving beside the
 * slide's text (WCAG 2.2.2). The player remounts a slide's scene when the
 * slide is shown again, so revisiting a slide plays it again. The pass and the
 * step timings are the prototype's (`jt-*` keyframes, 4.8 s, items arriving
 * at 18%, 38% and 58%); the prototype loops, the product plays once.
 */

/** A slide's one pass of animation, in ms. Every piece times itself on this. */
export const SCENE_LOOP_MS = 4800;

/** When, as a fraction of the pass, a piece of step 1, 2 or 3 starts arriving. */
export const STEP_STARTS = { 1: 0.18, 2: 0.38, 3: 0.58 } as const;

/** Arrival order inside a slide: step 1 first, then 2, then 3. */
export type SceneStep = keyof typeof STEP_STARTS;

/**
 * True when the stage is still. Provided by `SceneStage`; the default is
 * still, so a piece rendered outside a stage never moves on its own.
 */
const SceneStillContext = createContext<boolean>(true);

export const SceneStillProvider = SceneStillContext.Provider;

export function useSceneStill(): boolean {
    return use(SceneStillContext);
}

export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined') return false;
    // Optional call: absent in jsdom, and absent means "no stated preference".
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/**
 * Plays `frames` once on `ref`'s element when the stage moves, then lets the
 * markup (the final frame) show.
 *
 * `frames` must keep its identity between renders (build it in `useMemo` from
 * primitive inputs): a new array restarts the animation. A null `frames`
 * means "nothing to animate". The reduced-motion read here is a second guard
 * behind the stage's own `still`, so no piece can move against the setting
 * even when it is composed outside the player.
 */
export function useSceneLoop(ref: RefObject<Element | null>, frames: readonly Keyframe[] | null): void {
    const still = useSceneStill();
    useEffect(() => {
        if (still || frames === null || prefersReducedMotion()) return;
        const element = ref.current;
        // Optional call, like `ConfettiBurst`: no Web Animations API means the
        // markup's final frame simply stays.
        const animation = element?.animate?.(frames as Keyframe[], {
            duration: SCENE_LOOP_MS,
            iterations: 1,
        });
        return () => animation?.cancel?.();
    }, [ref, frames, still]);
}

const EASE_OUT = 'ease-out';
const HOLD = 'steps(1, end)';

/** A piece arriving at its step: from below, from the left, or brightening from dim. */
export function arriveFrames(step: SceneStep, from: 'below' | 'left' | 'dim'): Keyframe[] {
    const start = STEP_STARTS[step];
    if (from === 'dim') {
        return [
            { offset: 0, opacity: 0.4 },
            { offset: start, opacity: 0.4, easing: EASE_OUT },
            { offset: start + 0.13, opacity: 1 },
            { offset: 1, opacity: 1 },
        ];
    }
    const away = from === 'left' ? 'translateX(-40px)' : 'translateY(8px)';
    const travel = from === 'left' ? 0.2 : 0.14;
    return [
        { offset: 0, opacity: 0, transform: away },
        { offset: start, opacity: 0, transform: away, easing: EASE_OUT },
        { offset: start + travel, opacity: 1, transform: 'none' },
        { offset: 1, opacity: 1, transform: 'none' },
    ];
}

/** The tap ring's colour: the `--jale-blue-500` token at `percent` strength, so it follows the theme. */
function ring(percent: number): string {
    return `color-mix(in srgb, var(--jale-blue-500) ${percent}%, transparent)`;
}

/** A tap: an expanding ring (the default, near the end of the pass) or a quick press. */
export function tapFrames(kind: 'ring' | 'press', at: number): Keyframe[] {
    const land = clamp(at, 0, 0.8);
    if (kind === 'press') {
        return [
            { offset: 0, transform: 'none' },
            { offset: land, transform: 'none', easing: EASE_OUT },
            { offset: land + 0.06, transform: 'scale(.92)', easing: EASE_OUT },
            { offset: land + 0.12, transform: 'none' },
            { offset: 1, transform: 'none' },
        ];
    }
    return [
        { offset: 0, boxShadow: `0 0 0 0 ${ring(50)}` },
        { offset: land, boxShadow: `0 0 0 0 ${ring(50)}`, easing: EASE_OUT },
        { offset: land + 0.18, boxShadow: `0 0 0 12px ${ring(0)}` },
        { offset: 1, boxShadow: `0 0 0 0 ${ring(0)}` },
    ];
}

/** Text revealed left to right, as if typed, between 8% and 40% of the pass. */
export function typeFrames(): Keyframe[] {
    return [
        { offset: 0, clipPath: 'inset(0 100% 0 0)' },
        { offset: 0.08, clipPath: 'inset(0 100% 0 0)', easing: EASE_OUT },
        { offset: 0.4, clipPath: 'inset(0 0% 0 0)' },
        { offset: 1, clipPath: 'inset(0 0% 0 0)' },
    ];
}

/**
 * The pointer travels from its start to its target, rests, presses, and
 * rests again. The element is DRAWN at the target (its final frame), so the
 * travel is a translate from the start back to zero.
 */
export function pointerFrames(dx: number, dy: number): Keyframe[] {
    const away = `translate(${dx}px, ${dy}px)`;
    return [
        { offset: 0, transform: away },
        { offset: 0.12, transform: away, easing: 'ease-in-out' },
        { offset: 0.46, transform: 'none' },
        { offset: 0.64, transform: 'none', easing: EASE_OUT },
        { offset: 0.7, transform: 'scale(.82)', easing: EASE_OUT },
        { offset: 0.76, transform: 'none' },
        { offset: 1, transform: 'none' },
    ];
}

/** An "off" layer fading away once the piece of the same step has arrived. */
export function switchOnFrames(step: SceneStep): Keyframe[] {
    const start = STEP_STARTS[step] + 0.12;
    return [
        { offset: 0, opacity: 1 },
        { offset: start, opacity: 1, easing: EASE_OUT },
        { offset: start + 0.12, opacity: 0 },
        { offset: 1, opacity: 0 },
    ];
}

/**
 * When each state of an `n`-state cycle takes over, as fractions of the pass.
 * The first change lands at a third of the pass and the last at two thirds, so
 * the final state (the one the slide's text describes) holds longest.
 */
export function cycleTimes(count: number): number[] {
    if (count < 2) return [];
    if (count === 2) return [1 / 3];
    return Array.from({ length: count - 1 }, (_, index) => 1 / 3 + (index * (1 / 3)) / (count - 2));
}

/** State `index` of `count` is shown from its takeover until the next one. */
export function cycleFrames(index: number, count: number): Keyframe[] {
    const times = cycleTimes(count);
    const shownFrom = index === 0 ? 0 : times[index - 1];
    const shownUntil = index === count - 1 ? 1 : times[index];
    const frames: Keyframe[] = [];
    if (shownFrom > 0) frames.push({ offset: 0, opacity: 0, easing: HOLD });
    frames.push({ offset: shownFrom, opacity: 1, easing: HOLD });
    if (shownUntil < 1) frames.push({ offset: shownUntil, opacity: 0, easing: HOLD });
    frames.push({ offset: 1, opacity: shownUntil < 1 ? 0 : 1 });
    return frames;
}

/** Segment `index` of `count` fills in turn, the whole row full by two thirds of the pass. */
export function segmentFillFrames(index: number, count: number): Keyframe[] {
    const at = count <= 1 ? 1 / 3 : 0.08 + (index / (count - 1)) * (2 / 3 - 0.08);
    return [
        { offset: 0, opacity: 1, easing: HOLD },
        { offset: at, opacity: 0, easing: HOLD },
        { offset: 1, opacity: 0 },
    ];
}

/** A clock hand sweeping most of the way round during the second half of the pass. */
export function clockFrames(): Keyframe[] {
    return [
        { offset: 0, transform: 'rotate(0deg)' },
        { offset: 0.4, transform: 'rotate(0deg)' },
        { offset: 1, transform: 'rotate(300deg)' },
    ];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
