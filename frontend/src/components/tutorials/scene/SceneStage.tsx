'use client';

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { SceneStillProvider } from './motion';

/**
 * The tinted box a slide's scene is drawn in.
 *
 * Scenes are laid out on a FIXED design box, the prototype's 318 × 200 stage
 * (a 390 px phone, less the dialog's gutters and padding), and this stage
 * scales that box down to fit a narrower dialog. At 320 px the dialog body is
 * about 250 px wide: without scaling, a 270 px scene would be clipped. Wider
 * than the design box, the box stays at full size, centred on the tint.
 *
 * The stage also owns `still`: every animated piece inside reads it, so a
 * slide's scene only has to compose pieces, never thread a flag through them.
 *
 * Decoration only. The slide's title and body carry the meaning, so the whole
 * stage is hidden from assistive technology and holds nothing focusable.
 */

export const SCENE_WIDTH = 318;
export const SCENE_HEIGHT = 200;

/** Employer tutorials sit on blue, worker tutorials on teal, as in the prototype. */
export type SceneTone = 'blue' | 'teal';

const TONES: Record<SceneTone, string> = {
    blue: 'bg-[var(--jale-blue-50)]',
    teal: 'bg-[var(--jale-teal-50)]',
};

/** How far the design box shrinks to fit `width`. Never enlarged; unmeasured means full size. */
export function stageScale(width: number): number {
    if (!Number.isFinite(width) || width <= 0) return 1;
    return Math.min(1, width / SCENE_WIDTH);
}

export function SceneStage({ tone, still, children }: { tone: SceneTone; still: boolean; children: ReactNode }) {
    const [scale, setScale] = useState(1);

    // A ref callback with a cleanup (React 19) rather than an effect: it runs
    // when the node attaches, measures once, and follows later resizes where
    // a ResizeObserver exists. jsdom has none, and reports 0 width, which
    // `stageScale` reads as full size.
    const measure = useCallback((node: HTMLDivElement | null) => {
        if (!node) return;
        const update = () => setScale(stageScale(node.clientWidth));
        update();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={measure}
            aria-hidden="true"
            data-scene-stage=""
            className={[
                'relative w-full shrink-0 select-none overflow-hidden rounded-[var(--radius-input)]',
                TONES[tone],
            ].join(' ')}
            style={{ height: `${(SCENE_HEIGHT * scale).toFixed(1)}px` }}
        >
            <div
                className="absolute left-1/2 top-0 flex items-center justify-center text-[11px] leading-snug text-[var(--jale-ink)]"
                style={{
                    width: SCENE_WIDTH,
                    height: SCENE_HEIGHT,
                    transform: `translateX(-50%) scale(${scale === 1 ? '1' : scale.toFixed(3)})`,
                    transformOrigin: 'top center',
                }}
            >
                <SceneStillProvider value={still}>{children}</SceneStillProvider>
            </div>
        </div>
    );
}
