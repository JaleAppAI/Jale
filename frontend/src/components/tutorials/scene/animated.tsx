'use client';

import { Children, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import {
    SCENE_LOOP_MS,
    arriveFrames,
    clockFrames,
    cycleFrames,
    pointerFrames,
    prefersReducedMotion,
    segmentFillFrames,
    switchOnFrames,
    tapFrames,
    typeFrames,
    useSceneLoop,
    useSceneStill,
    type SceneStep,
} from './motion';

/**
 * The animated pieces of a tutorial scene. Each one renders its FINAL frame as
 * plain markup and, while the stage moves, plays a Web Animation over it once (see
 * `./motion`). Every animated element carries `data-scene-motion`, so a test
 * can check that each one, and nothing else, was animated.
 */

function cx(...parts: Array<string | false | undefined>): string {
    return parts.filter(Boolean).join(' ');
}

/**
 * A piece that arrives at its step: rising from below (the default), sliding
 * in from the left, or brightening from dim (something that unlocks).
 */
export function SlideIn({
    step = 1,
    from = 'below',
    as: Tag = 'div',
    className,
    children,
}: {
    step?: SceneStep;
    from?: 'below' | 'left' | 'dim';
    as?: 'div' | 'span';
    className?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLElement>(null);
    const frames = useMemo(() => arriveFrames(step, from), [step, from]);
    useSceneLoop(ref, frames);
    return (
        <Tag
            ref={ref as RefObject<HTMLDivElement & HTMLSpanElement>}
            aria-hidden="true"
            data-scene-motion=""
            className={className}
        >
            {children}
        </Tag>
    );
}

/**
 * A tap on what it wraps: an expanding ring (`kind="ring"`, the default, as a
 * finger lands on a button near the end of the pass) or a quick press
 * (`kind="press"`). `at` moves the moment, as a fraction of the pass.
 */
export function TapPulse({
    kind = 'ring',
    at,
    className,
    children,
}: {
    kind?: 'ring' | 'press';
    at?: number;
    className?: string;
    children: ReactNode;
}) {
    const ref = useRef<HTMLSpanElement>(null);
    const land = at ?? (kind === 'ring' ? 0.66 : 0.2);
    const frames = useMemo(() => tapFrames(kind, land), [kind, land]);
    useSceneLoop(ref, frames);
    return (
        <span
            ref={ref}
            aria-hidden="true"
            data-scene-motion=""
            className={cx('inline-flex rounded-full', className)}
        >
            {children}
        </span>
    );
}

/** Text that types itself in, left to right. Put it inside a `SceneField` for a field filling in. */
export function TypeOn({ className, children }: { className?: string; children: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const frames = useMemo(() => typeFrames(), []);
    useSceneLoop(ref, frames);
    return (
        <span
            ref={ref}
            aria-hidden="true"
            data-scene-motion=""
            className={cx('inline-block min-w-0 truncate', className)}
        >
            {children}
        </span>
    );
}

/**
 * A number counting up from `from` to `to` during the first half of the
 * slide's one pass, then holding `to`. Still, it shows `to`. `format` turns
 * the number into the text shown ("82", "3 of 7").
 */
export function CountUp({
    to,
    from = 0,
    format = String,
    className,
}: {
    to: number;
    from?: number;
    format?: (value: number) => string;
    className?: string;
}) {
    const still = useSceneStill();
    const [shown, setShown] = useState(to);

    useEffect(() => {
        if (still || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') return;
        let frame = 0;
        let startedAt: number | null = null;
        const tick = (now: number) => {
            if (startedAt === null) startedAt = now;
            const progress = (now - startedAt) / SCENE_LOOP_MS;
            // Counts between 8% and 50% of the pass, easing out as it lands,
            // then stops asking for frames: the count plays once, like the
            // rest of the scene.
            const travel = Math.min(1, Math.max(0, (progress - 0.08) / 0.42));
            const eased = 1 - (1 - travel) ** 3;
            setShown(Math.round(from + (to - from) * eased));
            if (travel < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        };
    }, [still, from, to]);

    // Still (or stopped), the final value: the effect above never ran, or its
    // last frame may have been mid-count.
    const value = still ? to : shown;
    return (
        <span aria-hidden="true" data-scene-count="" className={cx('tabular-nums', className)}>
            {format(value)}
        </span>
    );
}

export type ScenePoint = { x: number; y: number };

/**
 * The prototype's pointer: an arrow that travels from `from` to `to`, then
 * presses. Points are in the stage's 318 × 200 design box, from its top left.
 * Drawn only while the stage moves: a still frame has no pointer, as in the
 * prototype. Where there is no Web Animations API it simply rests on `to`.
 */
export function ScenePointer({ from, to }: { from: ScenePoint; to: ScenePoint }) {
    const still = useSceneStill();
    const ref = useRef<SVGSVGElement>(null);
    const frames = useMemo(() => pointerFrames(from.x - to.x, from.y - to.y), [from.x, from.y, to.x, to.y]);
    useSceneLoop(ref, frames);
    if (still) return null;
    return (
        <svg
            ref={ref}
            aria-hidden="true"
            data-scene-pointer=""
            data-scene-motion=""
            viewBox="0 0 18 18"
            className="pointer-events-none absolute h-[18px] w-[18px]"
            style={{ left: to.x, top: to.y }}
        >
            <path d="M2 1l13 8-6 1.5L6 17z" fill="var(--jale-ink)" stroke="var(--jale-card)" strokeWidth={1.2} />
        </svg>
    );
}

/**
 * A choice: a shift tile or a Yes/No pill. By default it switches ON once the
 * piece of the same step has arrived, and its final frame is "on". With
 * `on={false}` it is a choice that stays off, drawn still.
 */
export function SceneToggle({
    on = true,
    step = 1,
    shape = 'pill',
    className,
    children,
}: {
    on?: boolean;
    step?: SceneStep;
    shape?: 'pill' | 'tile';
    className?: string;
    children: ReactNode;
}) {
    const still = useSceneStill();
    const ref = useRef<HTMLSpanElement>(null);
    const frames = useMemo(() => (on ? switchOnFrames(step) : null), [on, step]);
    useSceneLoop(ref, frames);
    const box = shape === 'tile' ? 'rounded-[var(--radius-input)] px-2.5 py-2' : 'rounded-full px-2.5 py-1';
    const offLook = 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]';
    return (
        <span
            aria-hidden="true"
            data-scene-toggle={on ? 'on' : 'off'}
            className={cx(
                'relative inline-flex items-center justify-center overflow-hidden whitespace-nowrap border font-semibold',
                on ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-500)] text-white' : offLook,
                box,
                className,
            )}
        >
            {children}
            {on && !still ? (
                <span
                    ref={ref}
                    data-scene-toggle-off=""
                    data-scene-motion=""
                    className={cx('absolute inset-0 flex items-center justify-center border', offLook, box)}
                    // Drawn invisible: with no Web Animations API the toggle
                    // simply shows "on", its final frame.
                    style={{ opacity: 0 }}
                >
                    {children}
                </span>
            ) : null}
        </span>
    );
}

/** One state of a `SceneCycle`, animated on the cycle's clock. */
function CycleItem({ index, count, children }: { index: number; count: number; children: ReactNode }) {
    const ref = useRef<HTMLSpanElement>(null);
    const frames = useMemo(() => cycleFrames(index, count), [index, count]);
    // A one-state cycle has nothing to swap.
    useSceneLoop(ref, count > 1 ? frames : null);
    return (
        <span
            ref={ref}
            data-scene-cycle-item=""
            data-scene-motion=""
            className="col-start-1 row-start-1"
            style={{ opacity: index === count - 1 ? 1 : 0 }}
        >
            {children}
        </span>
    );
}

/**
 * States replacing one another in place, such as a status select going New →
 * Contacted → Talking, or an upload row becoming an uploaded one. Each child
 * is one state; the last is the final frame.
 */
export function SceneCycle({ className, children }: { className?: string; children: ReactNode }) {
    const states = Children.toArray(children);
    return (
        <span aria-hidden="true" className={cx('grid', className)}>
            {states.map((state, index) => (
                <CycleItem key={index} index={index} count={states.length}>
                    {state}
                </CycleItem>
            ))}
        </span>
    );
}

const SEGMENT_FILL = { blue: 'bg-[var(--jale-blue-500)]', teal: 'bg-[var(--jale-teal-500)]' } as const;
const SEGMENT_THICKNESS = { sm: 'h-1', md: 'h-1.5', lg: 'h-2' } as const;

/** One segment that starts empty and fills on its turn. */
function FillingSegment({ index, count, className }: { index: number; count: number; className: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const frames = useMemo(() => segmentFillFrames(index, count), [index, count]);
    useSceneLoop(ref, frames);
    const still = useSceneStill();
    return (
        <span data-scene-segment="filled" className={cx('relative block overflow-hidden rounded-full', className)}>
            {still ? null : (
                <span
                    ref={ref}
                    data-scene-motion=""
                    className="absolute inset-0 bg-[var(--jale-blue-100)]"
                    style={{ opacity: 0 }}
                />
            )}
        </span>
    );
}

/**
 * A segmented progress bar: a wizard's steps or onboarding's questions.
 * `filled` segments are done. `fill="sequence"` fills them one by one across
 * the pass, `fill="pop"` brings each labelled step in on steps 1–3, and
 * `labels` names each segment underneath.
 */
export function SceneSegments({
    count,
    filled = count,
    tone = 'blue',
    thickness = 'sm',
    fill = 'static',
    labels,
    className,
}: {
    count: number;
    filled?: number;
    tone?: 'blue' | 'teal';
    thickness?: 'sm' | 'md' | 'lg';
    fill?: 'static' | 'sequence' | 'pop';
    labels?: readonly ReactNode[];
    className?: string;
}) {
    const segments = Array.from({ length: count }, (_, index) => {
        const done = index < filled;
        const bar = cx(SEGMENT_THICKNESS[thickness], done ? SEGMENT_FILL[tone] : 'bg-[var(--jale-blue-100)]');
        const segment =
            done && fill === 'sequence' && index > 0 ? (
                <FillingSegment index={index} count={filled} className={bar} />
            ) : (
                <span data-scene-segment={done ? 'filled' : 'empty'} className={cx('block rounded-full', bar)} />
            );
        const label = labels?.[index];
        const column = (
            <>
                {segment}
                {label !== undefined ? <span className="text-[10px] font-semibold">{label}</span> : null}
            </>
        );
        if (fill === 'pop') {
            return (
                <SlideIn key={index} step={Math.min(3, index + 1) as SceneStep} className="flex flex-1 flex-col gap-1">
                    {column}
                </SlideIn>
            );
        }
        return (
            <span key={index} className="flex flex-1 flex-col gap-1">
                {column}
            </span>
        );
    });
    return (
        <div aria-hidden="true" className={cx('flex w-full gap-1.5', className)}>
            {segments}
        </div>
    );
}

/** A clock face whose hand sweeps round: a time window that is running. */
export function SceneClock({ className }: { className?: string }) {
    const ref = useRef<SVGPathElement>(null);
    const frames = useMemo(() => clockFrames(), []);
    useSceneLoop(ref, frames);
    return (
        <svg aria-hidden="true" viewBox="0 0 32 32" className={cx('h-8 w-8 shrink-0', className)}>
            <circle cx="16" cy="16" r="13" fill="var(--jale-card)" stroke="var(--jale-success)" strokeWidth={2} />
            <path
                ref={ref}
                data-scene-motion=""
                d="M16 16V8"
                stroke="var(--jale-success)"
                strokeWidth={2.2}
                strokeLinecap="round"
                style={{ transformOrigin: '16px 16px' }}
            />
            <circle cx="16" cy="16" r="1.8" fill="var(--jale-success)" />
        </svg>
    );
}
