'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { EyeOff } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useToast } from '@/components/ui/toast';
import type { TutorialOutcome, TutorialRole } from '@/lib/api/tutorials';
import type { PlayMode } from '@/lib/tutorials/progress';
import type { TutorialDefinition, TutorialSceneProps } from '@/lib/tutorials/types';
import { SceneStage, prefersReducedMotion } from './scene';

/**
 * One play of a tutorial: a dialog of 3–5 slides, each a small animated scene
 * over a title and a sentence or two (FE-1 §4.3, rulings R5 and R6).
 *
 * BUILT ON `Modal`, not a fork of it, with the dialog's own header (the
 * `HiredCelebrationModal` precedent): the eyebrow is the tutorial's title and
 * the dialog's accessible name, with Skip and a close X beside it.
 *
 * THE CONTROLS.
 *  - Back is hidden on the first slide; Skip on the last.
 *  - The last slide's primary button reads `<namespace>.cta_last` when the
 *    tutorial has one ("Let's start"), else "Got it" (R6).
 *  - ONE primary button element for the whole play, its label swapped, so the
 *    focus `Modal` puts on it never drops to the page between slides. When
 *    Back or Skip disappears from under focus, focus moves to it as well.
 *  - The X, Escape and a backdrop press are all Skip.
 *  - ←/→ move between slides, and so does a horizontal swipe on touch.
 *  - "Don't show this again" only in an `always` play (a guide shown because
 *    of the "every time" setting, K1-v2): it turns this guide off for the
 *    account and closes it as a skip, so a host it plays before still opens.
 *    First-time plays and replays never offer it.
 *
 * OUTCOMES. `onDismiss('completed')` from the last slide's button and
 * `onDismiss('skipped')` from every other way out, exactly once. The player
 * records nothing itself: the progress store decides whether this play is one
 * that records (an auto-open) or not (a replay).
 *
 * MOTION. `still` follows `prefers-reduced-motion` live. Still, the scene shows
 * its final frame and slides change with no fade.
 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    // Optional calls throughout: jsdom has no matchMedia, and older Safari
    // has only the deprecated addListener.
    const query = window.matchMedia?.(REDUCED_MOTION);
    if (!query) return () => {};
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
}

function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** A horizontal swipe has to travel this far, and further across than down, to turn a slide. */
const SWIPE_PX = 40;

export function TutorialPlayer({
    definition,
    vars,
    mode,
    onMute,
    onDismiss,
}: {
    definition: TutorialDefinition;
    vars?: TutorialSceneProps['vars'];
    /** Why it is playing; only an `always` play offers "Don't show this again". */
    mode?: PlayMode;
    /** Turns this guide off for the account; resolves false when that was not saved. */
    onMute?: () => Promise<boolean>;
    onDismiss: (outcome: TutorialOutcome) => void;
}) {
    const t = useTranslations(definition.namespace);
    const tCommon = useTranslations('tutorial.common');
    const titleId = useId();
    const textId = useId();
    const still = useReducedMotion();

    const slides = definition.slides;
    const lastIndex = slides.length - 1;
    const [index, setIndex] = useState(0);
    const slide = slides[Math.min(index, lastIndex)];
    const isLast = index >= lastIndex;

    const primaryRef = useRef<HTMLButtonElement>(null);
    const dialogBodyRef = useRef<HTMLDivElement>(null);

    // The latest `onDismiss`, and whether this play already ended: Escape and
    // a click landing in the same tick still dismiss exactly once.
    const dismissRef = useRef(onDismiss);
    const dismissedRef = useRef(false);
    useLayoutEffect(() => {
        dismissRef.current = onDismiss;
    });
    const dismiss = useCallback((outcome: TutorialOutcome) => {
        if (dismissedRef.current) return;
        dismissedRef.current = true;
        dismissRef.current(outcome);
    }, []);
    const skip = useCallback(() => dismiss('skipped'), [dismiss]);

    const next = useCallback(() => setIndex((current) => Math.min(current + 1, lastIndex)), [lastIndex]);
    const back = useCallback(() => setIndex((current) => Math.max(current - 1, 0)), []);

    // ←/→ anywhere in the dialog. Modal owns Escape and Tab; it registers its
    // listener in the capture phase, this one bubbles.
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                next();
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                back();
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [next, back]);

    // Back disappears on the first slide and Skip on the last. If focus was
    // on the one that went, the browser drops it to <body>; put it on the
    // primary button instead. Not on the first render: Modal places the
    // initial focus itself once its portal exists.
    const shownIndexRef = useRef(index);
    useLayoutEffect(() => {
        if (shownIndexRef.current === index) return;
        shownIndexRef.current = index;
        const body = dialogBodyRef.current;
        const active = document.activeElement;
        if (!body || (active && active !== document.body && body.contains(active))) return;
        primaryRef.current?.focus();
    }, [index]);

    const swipeRef = useRef<{ id: number; x: number; y: number } | null>(null);
    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        // Touch and pen only: a mouse drag over the scene is a text selection
        // attempt, not a page turn.
        if (event.pointerType === 'mouse') return;
        swipeRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        const start = swipeRef.current;
        swipeRef.current = null;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
        if (dx < 0) next();
        else back();
    };
    const onPointerCancel = () => {
        swipeRef.current = null;
    };

    if (!slide) return null;

    // Placeholders in a slide's title or body are filled from the host's vars.
    const values = vars ? { ...vars } : undefined;
    const lastLabel = t.has('cta_last') ? t('cta_last') : tCommon('got_it');
    const Scene = slide.Scene;

    return (
        <Modal open onClose={skip} labelledById={titleId} size="sm" initialFocusRef={primaryRef}>
            <div ref={dialogBodyRef} className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-2">
                    <span
                        id={titleId}
                        className="min-w-0 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-blue-700)]"
                    >
                        {t(definition.titleKey)}
                    </span>
                    <div className="-mr-2 flex shrink-0 items-center gap-1">
                        {isLast ? null : (
                            <button
                                type="button"
                                onClick={skip}
                                className={[
                                    'relative inline-flex h-10 cursor-pointer items-center rounded-full px-2.5',
                                    'text-[13px] font-medium text-[var(--jale-ink-2)] transition-colors',
                                    'hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                    "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-full after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                                ].join(' ')}
                            >
                                {tCommon('skip')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={skip}
                            aria-label={tCommon('close')}
                            title={tCommon('close')}
                            className={[
                                // `Sheet`'s close recipe: a 40px box, a 44px pointer target.
                                'relative inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full',
                                'text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                            ].join(' ')}
                        >
                            <Icon name="x" />
                        </button>
                    </div>
                </div>

                <div
                    data-tutorial-swipe=""
                    className="flex touch-pan-y flex-col gap-4"
                    onPointerDown={onPointerDown}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                >
                    {/* Keyed by slide: each slide's scene starts its loop from
                        the top, and fades in unless motion is reduced. */}
                    <div key={slide.id} className={still ? undefined : 'anim-fade-in'}>
                        <SceneStage tone={definition.role === 'worker' ? 'teal' : 'blue'} still={still}>
                            <Scene still={still} vars={vars} />
                        </SceneStage>
                    </div>

                    {/* Stable across slides, so a screen reader hears each new
                        slide; the first is read with the focused button. */}
                    <div id={textId} aria-live="polite" aria-atomic="true" className="flex flex-col gap-1.5">
                        <span className="text-[11px] font-semibold text-[var(--jale-ink-2)]">
                            {tCommon('counter', { current: index + 1, total: slides.length })}
                        </span>
                        <h2 className="text-balance text-[22px] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
                            {t(slide.titleKey, values)}
                        </h2>
                        <p className="text-sm leading-normal text-[var(--jale-ink-2)]">{t(slide.bodyKey, values)}</p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div aria-hidden="true" className="flex items-center gap-1.5">
                        {slides.map((item, position) => (
                            <span
                                key={item.id}
                                className={[
                                    'h-1.5 rounded-full',
                                    position === index ? 'w-[18px] bg-[var(--jale-blue-500)]' : 'w-1.5 bg-[var(--jale-blue-100)]',
                                ].join(' ')}
                            />
                        ))}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        {index > 0 ? (
                            <Button variant="ghost" onClick={back} className="px-[18px]">
                                {tCommon('back')}
                            </Button>
                        ) : null}
                        <Button
                            ref={primaryRef}
                            onClick={isLast ? () => dismiss('completed') : next}
                            aria-describedby={textId}
                        >
                            {isLast ? lastLabel : tCommon('next')}
                        </Button>
                    </div>
                </div>

                {mode === 'always' && onMute ? (
                    <MuteControl role={definition.role} onMute={onMute} onSkip={skip} />
                ) : null}
            </div>
        </Modal>
    );
}

/**
 * "Don't show this again". The change shows at once (the store saves it
 * optimistically), the guide closes, and a toast says where to turn it back
 * on; a save that fails says so in a second toast.
 */
function MuteControl({
    role,
    onMute,
    onSkip,
}: {
    role: TutorialRole;
    onMute: () => Promise<boolean>;
    onSkip: () => void;
}) {
    const t = useTranslations('tutorial.help_center');
    const toast = useToast();

    const turnOff = () => {
        const failed = t(`${role}.save_failed`);
        toast.success(t(`${role}.muted_toast`));
        void onMute().then((saved) => {
            if (!saved) toast.error(failed);
        });
        onSkip();
    };

    return (
        <div className="-mt-1 flex justify-center border-t border-[var(--jale-divider)] pt-1">
            <button
                type="button"
                onClick={turnOff}
                className={[
                    'inline-flex h-11 cursor-pointer items-center gap-2 rounded-full px-3',
                    'text-[13px] font-medium text-[var(--jale-ink-2)] transition-colors',
                    'hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                ].join(' ')}
            >
                <EyeOff aria-hidden="true" className="h-4 w-4 shrink-0" />
                {t('mute')}
            </button>
        </div>
    );
}
