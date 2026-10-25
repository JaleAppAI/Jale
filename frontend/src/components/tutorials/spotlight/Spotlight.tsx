'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { useOverlayPresence } from '@/lib/tutorials/overlay';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { focusableWithin } from '@/components/ui/modal';
import { prefersReducedMotion } from '../scene/motion';
import { cutoutFor, placeCallout, type Box, type Placement } from './geometry';
import { buildSteps, nextAvailable, resolveTarget, type SpotlightIntro, type SpotlightStep } from './steps';

/**
 * The spotlight walkthrough engine: an optional opening card, then one
 * callout per step, each pointing at a real control on the page. The app tour
 * is its first client (`../AppTour`); a task walkthrough is another list of
 * steps (see `./steps` for what a step can say and do).
 *
 * Not a `Modal`: a modal's full scrim would hide the very controls a step
 * points at. Instead the scrim has a cutout around the current control,
 * ringed so it reads as highlighted, and the callout sits beside it.
 * Everything else a dialog owes the person is still here: focus moves into
 * the callout and Tab stays inside it (and the control, on an interactive
 * step), Escape skips, focus goes back where it was at the end, the page
 * behind does not scroll, and the walkthrough counts as an open overlay so no
 * tutorial auto-opens over it.
 *
 * POINTER. The scrim itself is decoration; four blockers around the cutout
 * catch the pointer, so the page cannot be used outside it. Over the cutout a
 * fifth blocker stops the pointer too, unless the step is `interactive`.
 *
 * STEPS ON SCREEN. The list is cut, when the walkthrough starts, to the steps
 * whose control is on screen then, so the counter's total is what the person
 * will see. A control that has gone by the time its step comes is passed
 * over; one that goes while its step is up leaves the callout centred, with
 * no cutout, until the person moves on. With no step on screen at all, the
 * walkthrough is unavailable and draws nothing.
 *
 * Copy: the step and intro keys come from the client; the buttons and the
 * counter are the shared `tutorial.common` ones.
 *
 * Layer: `z-40`, above the shell's sticky header (10), the phone tab bar (20)
 * and the conversation drawer (30), and under the dialog layer (`Modal`,
 * `Sheet` and toasts at 50).
 */

export type SpotlightProps = {
    /** Every step, in order; the ones not on screen at the start are dropped. */
    steps: readonly SpotlightStep[];
    /** An opening card before the first step. */
    intro?: SpotlightIntro;
    /** The last step's Got it is `completed`; Skip, Escape and the intro's "not now" are `skipped`. */
    onDismiss: (outcome: TutorialOutcome) => void;
    /** No step had a control on screen: nothing was shown. */
    onUnavailable: () => void;
    /** Named on the root element (`data-spotlight`). */
    name: string;
};

type Layout = { hole: Box; placement: Placement };

/** The scrim cutout's and the ring's corner radius, in px. */
const CUTOUT_RADIUS = 12;

/** What a step's `advanceWhen` is asked again on. */
const ADVANCE_EVENTS = ['input', 'change', 'click'] as const;

function sameLayout(a: Layout | null, b: Layout | null): boolean {
    if (a === null || b === null) return a === b;
    return (
        a.hole.top === b.hole.top &&
        a.hole.left === b.hole.left &&
        a.hole.width === b.hole.width &&
        a.hole.height === b.hole.height &&
        a.placement.side === b.placement.side &&
        a.placement.top === b.placement.top &&
        a.placement.left === b.placement.left &&
        a.placement.arrow === b.placement.arrow
    );
}

function isOnScreen(step: SpotlightStep): boolean {
    return resolveTarget(step.target) !== null;
}

/** The arrow is a small rotated square on the callout's edge that faces the target. */
function arrowStyle(placement: Placement): CSSProperties {
    const offset = placement.arrow - 7;
    if (placement.side === 'top') return { bottom: -7, left: offset };
    if (placement.side === 'bottom') return { top: -7, left: offset };
    return { left: -7, top: offset };
}

/** The pointer-catching rectangles around (and, unless interactive, over) the cutout. */
function blockers(hole: Box | null, interactive: boolean): Array<{ key: string; style: CSSProperties }> {
    if (hole === null) return [{ key: 'all', style: { inset: 0 } }];
    const bottom = hole.top + hole.height;
    const right = hole.left + hole.width;
    const parts: Array<{ key: string; style: CSSProperties }> = [
        { key: 'above', style: { top: 0, left: 0, right: 0, height: Math.max(0, hole.top) } },
        { key: 'below', style: { top: bottom, left: 0, right: 0, bottom: 0 } },
        { key: 'left', style: { top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height } },
        { key: 'right', style: { top: hole.top, left: right, right: 0, height: hole.height } },
    ];
    if (!interactive) {
        parts.push({ key: 'hole', style: { top: hole.top, left: hole.left, width: hole.width, height: hole.height } });
    }
    return parts;
}

const TEXT_BUTTON = [
    'inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full px-4 text-sm font-semibold',
    'transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

const CARD =
    'pointer-events-auto rounded-[var(--radius-card)] bg-[var(--jale-card)] text-[var(--jale-ink)] shadow-[var(--shadow-modal)] outline-none';

export function Spotlight({ steps: allSteps, intro, onDismiss, onUnavailable, name }: SpotlightProps) {
    const t = useTranslations();
    const tCommon = useTranslations('tutorial.common');
    const titleId = useId();
    const bodyId = useId();
    // `url(#…)` needs an id with no punctuation in it.
    const maskId = `spotlight-mask-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

    // The steps on screen as the walkthrough starts. Fixed from then on, so
    // the counter's total does not move under the person.
    const [steps] = useState<readonly SpotlightStep[]>(() =>
        typeof document === 'undefined' ? [] : buildSteps(allSteps, isOnScreen),
    );
    const available = steps.length > 0;
    /** -1 is the intro card; 0.. are the steps. */
    const [index, setIndex] = useState(intro ? -1 : 0);
    const [layout, setLayout] = useState<Layout | null>(null);
    const [reducedMotion] = useState(prefersReducedMotion);

    const dialogRef = useRef<HTMLDivElement>(null);
    const primaryRef = useRef<HTMLButtonElement>(null);
    const endedRef = useRef(false);

    useOverlayPresence(available);

    // Nothing to point at: the play ends without an outcome.
    useEffect(() => {
        if (!available) onUnavailable();
    }, [available, onUnavailable]);

    const end = useCallback(
        (outcome: TutorialOutcome) => {
            if (endedRef.current) return;
            endedRef.current = true;
            onDismiss(outcome);
        },
        [onDismiss],
    );

    const goTo = useCallback(
        (from: number, direction: 1 | -1) => {
            const to = nextAvailable(steps, from, direction, isOnScreen);
            if (to !== -1) setIndex(to);
            else if (direction === 1) end('completed');
        },
        [steps, end],
    );

    // Focus goes back to whatever had it when the walkthrough ends. Declared
    // before the effect that moves focus in, so it reads the opener first.
    useEffect(() => {
        if (!available) return;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => {
            if (opener?.isConnected) opener.focus();
        };
    }, [available]);

    // Focus into the card, and back into it whenever the control that had it
    // went away (the intro card swapping for the first step, or Back
    // disappearing on the first step).
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (!dialog.contains(document.activeElement)) (primaryRef.current ?? dialog).focus();
    }, [index, available]);

    // The page behind stays put, as under a Modal.
    useEffect(() => {
        if (!available) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [available]);

    const step = index >= 0 ? (steps[index] ?? null) : null;
    const interactive = step?.interactive === true;

    // Escape skips; Tab cycles inside the card, plus the control on an
    // interactive step. Capture phase, as in Modal.
    useEffect(() => {
        if (!available) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                end('skipped');
                return;
            }
            if (event.key !== 'Tab') return;
            const dialog = dialogRef.current;
            if (!dialog) return;
            const control = interactive && step ? resolveTarget(step.target) : null;
            const controlItems = control
                ? focusableWithin(control.parentElement ?? control).filter(
                      (element) => element === control || control.contains(element),
                  )
                : [];
            const items = [...controlItems, ...focusableWithin(dialog)];
            const active = document.activeElement;
            if (items.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const inside = dialog.contains(active) || (control !== null && control.contains(active));
            if (event.shiftKey) {
                if (!inside || active === first) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (!inside || active === last) {
                event.preventDefault();
                first.focus();
            }
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [available, end, interactive, step]);

    // Where the cutout and the callout go for the current step.
    const measure = useCallback(() => {
        const current = index >= 0 ? steps[index] : undefined;
        const callout = dialogRef.current;
        const target = current ? resolveTarget(current.target) : null;
        if (!current || !callout || !target) {
            // A control that has gone since the step showed: the callout
            // centres itself, with no cutout, until the person moves on.
            setLayout(null);
            return;
        }
        const rect = target.getBoundingClientRect();
        const box = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        const size = callout.getBoundingClientRect();
        const next: Layout = {
            hole: cutoutFor(box),
            placement: placeCallout(
                box,
                { width: size.width, height: size.height },
                { width: window.innerWidth, height: window.innerHeight },
                current.placement,
            ),
        };
        setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    }, [index, steps]);

    // Measured before paint on every step, and again whenever the viewport,
    // a scroll position, the control or the callout changes size.
    useLayoutEffect(() => {
        if (index < 0 || !available) return;
        const target = resolveTarget(steps[index].target);
        // Optional call: jsdom has no scrollIntoView. A fixed tab bar or a
        // sticky header is already in view, and this does nothing to them.
        target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => measure());
            if (target) observer.observe(target);
            if (dialogRef.current) observer.observe(dialogRef.current);
        }
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
            observer?.disconnect();
        };
    }, [index, steps, available, measure]);

    // A step that moves on by itself: asked again on every input, change and
    // click inside its control.
    useEffect(() => {
        if (step === null || !step.advanceWhen) return;
        const target = resolveTarget(step.target);
        if (!target) return;
        const advanceWhen = step.advanceWhen;
        const check = () => {
            if (advanceWhen(target)) goTo(index, 1);
        };
        for (const type of ADVANCE_EVENTS) target.addEventListener(type, check);
        return () => {
            for (const type of ADVANCE_EVENTS) target.removeEventListener(type, check);
        };
    }, [step, index, goTo]);

    if (!available || typeof document === 'undefined') return null;

    const isLast = index === steps.length - 1;
    const hole = step && layout ? layout.hole : null;
    const placement = step && layout ? layout.placement : null;
    const transition = reducedMotion
        ? 'none'
        : 'top var(--motion-duration-slow) ease-out, left var(--motion-duration-slow) ease-out, width var(--motion-duration-slow) ease-out, height var(--motion-duration-slow) ease-out';

    return createPortal(
        <div
            className="pointer-events-none fixed inset-0 z-40"
            data-spotlight={name}
            data-motion={reducedMotion ? 'reduced' : 'full'}
        >
            {/* The scrim: decoration only. */}
            <svg aria-hidden="true" focusable="false" className="absolute inset-0 h-full w-full">
                <defs>
                    <mask id={maskId}>
                        <rect x="0" y="0" width="100%" height="100%" fill="white" />
                        {hole ? (
                            <rect
                                x={hole.left}
                                y={hole.top}
                                width={hole.width}
                                height={hole.height}
                                rx={CUTOUT_RADIUS}
                                fill="black"
                            />
                        ) : null}
                    </mask>
                </defs>
                <rect
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                    mask={`url(#${maskId})`}
                    style={{ fill: 'var(--jale-backdrop)' }}
                />
            </svg>

            {/* What keeps the page inert: everywhere but an interactive cutout. */}
            {blockers(hole, interactive).map((blocker) => (
                <div
                    key={blocker.key}
                    aria-hidden="true"
                    data-spotlight-blocker={blocker.key}
                    className="pointer-events-auto absolute"
                    style={blocker.style}
                />
            ))}

            {hole ? (
                <div
                    aria-hidden="true"
                    data-spotlight-ring=""
                    className="absolute"
                    style={{
                        top: hole.top,
                        left: hole.left,
                        width: hole.width,
                        height: hole.height,
                        borderRadius: CUTOUT_RADIUS,
                        boxShadow: '0 0 0 3px var(--primary-fg)',
                        transition,
                    }}
                />
            ) : null}

            {step === null && intro ? (
                <div className="absolute inset-0 flex items-center justify-center p-4">
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={titleId}
                        aria-describedby={bodyId}
                        tabIndex={-1}
                        className={`${reducedMotion ? '' : 'anim-fade-in '}w-full max-w-[440px] p-6 ${CARD}`}
                    >
                        <span
                            aria-hidden="true"
                            className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-card)] bg-[var(--jale-teal-500)] text-[var(--primary-fg)]"
                        >
                            <Icon name="spark" />
                        </span>
                        <h2 id={titleId} className="text-xl font-bold leading-tight">
                            {t(intro.titleKey)}
                        </h2>
                        <p id={bodyId} className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
                            {t(intro.bodyKey)}
                        </p>
                        {/* The primary action first in the DOM, so it is the
                            first stop; on wider screens it sits on the right. */}
                        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
                            <Button ref={primaryRef} onClick={() => goTo(-1, 1)}>
                                {t(intro.startKey)}
                            </Button>
                            <button
                                type="button"
                                className={`${TEXT_BUTTON} text-[var(--jale-ink)]`}
                                onClick={() => end('skipped')}
                            >
                                {t(intro.notNowKey)}
                            </button>
                        </div>
                    </div>
                </div>
            ) : step ? (
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={bodyId}
                    tabIndex={-1}
                    data-step={step.id}
                    data-side={placement?.side ?? 'center'}
                    className={`absolute w-[min(360px,calc(100vw-32px))] p-4 ${CARD}`}
                    style={
                        placement
                            ? { top: placement.top, left: placement.left, transition }
                            : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
                    }
                >
                    {placement ? (
                        <span
                            aria-hidden="true"
                            className="absolute h-3.5 w-3.5 rotate-45 bg-[var(--jale-card)]"
                            style={arrowStyle(placement)}
                        />
                    ) : null}
                    <p className="relative text-xs font-semibold text-[var(--jale-ink-2)]">
                        {tCommon('counter', { current: index + 1, total: steps.length })}
                    </p>
                    <h2 id={titleId} className="relative mt-1 text-lg font-bold leading-tight">
                        {t(step.titleKey)}
                    </h2>
                    <p id={bodyId} className="relative mt-1 text-sm leading-6">
                        {t(step.bodyKey)}
                    </p>
                    <div className="relative mt-3 flex items-center justify-between gap-2">
                        <button
                            type="button"
                            className={`${TEXT_BUTTON} -ml-2 text-[var(--jale-ink-2)]`}
                            onClick={() => end('skipped')}
                        >
                            {tCommon('skip')}
                        </button>
                        <div className="flex gap-2">
                            {index > 0 ? (
                                <Button variant="outline" onClick={() => goTo(index, -1)}>
                                    {tCommon('back')}
                                </Button>
                            ) : null}
                            <Button ref={primaryRef} onClick={() => goTo(index, 1)}>
                                {isLast ? tCommon('got_it') : tCommon('next')}
                            </Button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>,
        document.body,
    );
}
