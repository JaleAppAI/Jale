'use client';
import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';

/**
 * The confetti behind the hire celebration's header. No library: twenty-seven
 * absolutely-positioned pieces and one flash, driven by the Web Animations
 * API.
 *
 * THE ONE IDEA THAT MAKES THE REST SIMPLE: each piece is laid out AT ITS
 * RESTING SPOT, in percentages, and the explosion is a transform DELTA layered
 * on top of that — the flight starts translated back to the header centre and
 * animates to `translate(0,0)`.
 *
 * Positioning them at the origin and flying them out (the obvious reading of
 * the prototype) would need three separate correct behaviours: the animated
 * path, a reduced-motion path that writes the resting transform by hand, and a
 * no-WAAPI path that does the same. Anchoring the layout at the rest position
 * collapses all three into one: the markup alone is already the finished
 * picture, so a browser that honours `prefers-reduced-motion`, a runtime with
 * no `Element.animate` (jsdom, and older mobile Safari), and a JS bundle that
 * never arrives all show the same settled confetti instead of a blank header
 * or a pile of pieces stacked in the middle.
 *
 * Two guards are load-bearing rather than defensive:
 *  - `window.matchMedia` is read optionally. It is genuinely absent in this
 *    repo's jsdom, so `matchMedia(...)` unguarded throws inside the effect and
 *    takes the whole modal down in every component test that renders it.
 *  - `el.animate?.(…)` for the same reason: jsdom implements no Web Animations
 *    API at all, and the guard is what makes the settled-at-rest markup above
 *    the graceful answer rather than a crash.
 *
 * The geometry is drawn ONCE (`useMemo` with no deps) and never recomputed: a
 * parent re-render that re-rolled `Math.random()` would teleport every piece
 * mid-flight. It is safe to randomise despite SSR because the only caller is
 * inside `Modal`, which portals nothing until its post-hydration `mounted`
 * effect — this component never renders on the server, so there is no
 * hydration pass for the random values to disagree with.
 */

/** Brand blue, success green, gold and coral — the prototype's exact ramp. */
const COLORS = [
    'var(--jale-blue-500)',
    'var(--jale-success)',
    '#f5b400',
    '#ff7a59',
    'var(--jale-blue-500)',
    '#f5b400',
    '#7fd6a4',
];

const COLS = 9;
const ROWS = 3;

/** Fallback header box for a layer that has not been measured (jsdom, or a
 *  first paint before layout). Only the flight deltas use it; the resting
 *  layout is in percentages and needs no measurement at all. */
const FALLBACK_WIDTH = 420;
const FALLBACK_HEIGHT = 130;

type Piece = {
    /** Resting spot as a 0..1 fraction of the layer, so layout needs no measure. */
    x: number;
    y: number;
    rotation: number;
    color: string;
    round: boolean;
    hoverDuration: string;
    /** Negative, so the hover is already mid-cycle when it starts. */
    hoverDelay: string;
    flightDelay: number;
};

/**
 * One piece per cell of a 9×3 grid, jittered inside its own cell and inset
 * from the edges. A grid rather than free randomness because 27 independently
 * random points clump, and a clump reads as a smudge rather than as confetti.
 */
function buildPieces(): Piece[] {
    const pieces: Piece[] = [];
    for (let row = 0; row < ROWS; row += 1) {
        for (let col = 0; col < COLS; col += 1) {
            const index = row * COLS + col;
            pieces.push({
                x: 0.04 + ((col + 0.15 + Math.random() * 0.7) / COLS) * 0.92,
                y: 0.04 + ((row + 0.15 + Math.random() * 0.7) / ROWS) * 0.92,
                rotation: Math.round(Math.random() * 540 - 270),
                color: COLORS[index % COLORS.length],
                round: index % 4 === 3,
                hoverDuration: `${(2 + Math.random() * 1.4).toFixed(2)}s`,
                hoverDelay: `${(-Math.random() * 3).toFixed(2)}s`,
                flightDelay: Math.round(Math.random() * 90),
            });
        }
    }
    return pieces;
}

function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined') return false;
    // Optional call, not an `in` check: absent in jsdom, and absent means
    // "no stated preference", not "reduce".
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

export function ConfettiBurst({ className = '' }: { className?: string }) {
    const layerRef = useRef<HTMLDivElement>(null);
    const flashRef = useRef<HTMLSpanElement>(null);
    const pieces = useMemo(buildPieces, []);

    useEffect(() => {
        if (prefersReducedMotion()) return;

        const layer = layerRef.current;
        if (!layer) return;

        const width = layer.clientWidth || FALLBACK_WIDTH;
        const height = layer.clientHeight || FALLBACK_HEIGHT;
        const originX = width / 2;
        const originY = height / 2;
        const longest = Math.max(width, height);

        // A single bright pulse at the origin, so the pieces read as thrown
        // from somewhere rather than as having faded in.
        //
        // The `translate(-50%,-50%)` is repeated in BOTH keyframes rather than
        // left to the element's classes: an animated `transform` replaces the
        // whole property, so a bare `scale()` would drop the centring for the
        // duration and expand the pulse about a point 9px down-right of the
        // header centre. Same rule the pieces' final keyframe follows by
        // restating their resting `rotate()`.
        flashRef.current?.animate?.(
            [
                { opacity: 0.9, transform: 'translate(-50%,-50%) scale(.4)' },
                { opacity: 0, transform: 'translate(-50%,-50%) scale(7)' },
            ],
            { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
        );

        const elements = layer.querySelectorAll<HTMLElement>('[data-confetti-piece]');
        elements.forEach((element, index) => {
            const piece = pieces[index];
            if (!piece) return;

            // Delta from the resting spot BACK to the origin: the flight
            // starts here and ends at zero.
            const dx = originX - piece.x * width;
            const dy = originY - piece.y * height;
            const distance = Math.hypot(dx, dy);
            // Out past the resting spot, then drift back in and settle. Longer
            // throws overshoot further, which is what stops the whole burst
            // arriving at once.
            const overshoot = 0.10 + (distance / longest) * 0.12;

            element.animate?.(
                [
                    { opacity: 0, transform: `translate(${dx.toFixed(0)}px,${dy.toFixed(0)}px) rotate(0deg) scale(.2)`, offset: 0 },
                    { opacity: 1, offset: 0.08 },
                    {
                        transform: `translate(${(-dx * overshoot).toFixed(0)}px,${(-dy * overshoot).toFixed(0)}px) rotate(${Math.round(piece.rotation * 0.8)}deg) scale(1.15)`,
                        offset: 0.55,
                        easing: 'cubic-bezier(.05,.75,.2,1)',
                    },
                    { opacity: 0.9, transform: `translate(0,0) rotate(${piece.rotation}deg) scale(1)`, offset: 1 },
                ],
                {
                    duration: 700 + distance * 1.4,
                    delay: piece.flightDelay,
                    easing: 'cubic-bezier(.16,.9,.3,1)',
                    // Never rewind: the resting frame is also the markup's own
                    // static style, so forwards-fill and no-JS agree exactly.
                    fill: 'forwards',
                },
            );
        });
    }, [pieces]);

    return (
        <div
            ref={layerRef}
            data-confetti-layer
            aria-hidden="true"
            className={['pointer-events-none absolute inset-0 z-0 overflow-hidden', className]
                .filter(Boolean)
                .join(' ')}
        >
            {/* Invisible until animated, so the reduced-motion and no-WAAPI
                paths simply never light it up. */}
            <span
                ref={flashRef}
                className="absolute h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0"
                style={{ left: '50%', top: '50%', background: 'var(--jale-success)' }}
            />
            {pieces.map((piece, index) => (
                <i
                    key={index}
                    data-confetti-piece
                    className="absolute block will-change-transform"
                    style={{
                        left: `${(piece.x * 100).toFixed(2)}%`,
                        top: `${(piece.y * 100).toFixed(2)}%`,
                        width: 8,
                        height: piece.round ? 8 : 12,
                        opacity: 0.9,
                        transform: `rotate(${piece.rotation}deg)`,
                    }}
                >
                    <b
                        className="anim-hire-hover block h-full w-full"
                        style={{
                            background: piece.color,
                            borderRadius: piece.round ? '50%' : 2,
                            '--hire-hover-duration': piece.hoverDuration,
                            '--hire-hover-delay': piece.hoverDelay,
                        } as React.CSSProperties}
                    />
                </i>
            ))}
        </div>
    );
}
