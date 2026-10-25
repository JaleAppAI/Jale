'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { useOverlayPresence } from '@/lib/tutorials/overlay';
import { focusableWithin } from '@/components/ui/modal';
import { prefersReducedMotion } from '../scene/motion';
import { DoneCard, IntroCard, StepCallout, type StepPrimary } from './cards';
import { cutoutFor, placeCallout, unionBox, type Band, type Box, type Placement } from './geometry';
import { holdPageScroll } from './page-lock';
import { dialogOf, modalOver, openPopupsOf, ownsOpenPopup, scrollIntoContainer, scrollParentWithin } from './scope';
import {
    applies,
    buildSteps,
    isInteractive,
    isLastApplicable,
    isReady,
    isRendered,
    liveCount,
    nextAvailable,
    previousStep,
    resolveTarget,
    type SpotlightDone,
    type SpotlightIntro,
    type SpotlightStep,
    type SpotlightTarget,
} from './steps';

/**
 * The spotlight walkthrough engine: an optional opening card, then one
 * callout per step, each pointing at a real control on the page, then an
 * optional closing card. The app tour is its first client (`../AppTour`); the
 * task walkthroughs (`../guides`, drawn by `../GuideHost`) are the others.
 *
 * Not a `Modal`: a modal's full scrim would hide the very controls a step
 * points at. Instead the scrim has a cutout around the current control,
 * ringed so it reads as highlighted, and the callout sits beside it.
 * Everything else a dialog owes the person is still here: focus moves into
 * the callout and Tab stays inside it (and the control, on an interactive
 * step), Escape ends it, focus goes back where it was at the end, the page
 * behind does not scroll, and the walkthrough counts as an open overlay so no
 * tutorial auto-opens over it.
 *
 * POINTER. The scrim itself is decoration; four blockers around the cutout
 * catch the pointer, so the page cannot be used outside it. Over the cutout a
 * fifth blocker stops the pointer too, unless the step is interactive. An
 * interactive control's open popup (a combobox's list) is part of the cutout.
 *
 * FINDING THE CONTROLS (`resolve`).
 *  - `start` (the app tour): the list is cut, when the walkthrough starts, to
 *    the steps whose control is on screen then, so the counter's total is
 *    what the person will see. A control that has gone by the time its step
 *    comes is passed over; one that goes while its step is up leaves the
 *    callout centred, with no cutout, until the person moves on. With no step
 *    on screen at all, the walkthrough is unavailable and draws nothing.
 *  - `lazy` (a task walkthrough): a step's control is looked for when the step
 *    is reached, and waited for (any change to the page, up to `waitMs`) when
 *    it is not there yet; one that never comes is skipped. A step whose
 *    `when` is false is skipped too. Nothing is drawn until the first step's
 *    control is on screen: that is how a walkthrough started together with
 *    its host (the post-job wizard) knows the host is up. If it never shows,
 *    the walkthrough is unavailable. The counter counts the steps that apply
 *    now, so it may change when a branch does.
 *
 * INSIDE A DIALOG (see `./scope`). When the controls sit in a
 * `[role="dialog"]` (a `Modal`), the layer is portaled into that dialog, the
 * dialog keeps its own scroll lock, controls are scrolled into view within
 * the dialog's scrolling body, and the callout stays inside that body. The
 * walkthrough's own Tab and Escape run first (a `window` capture listener,
 * ahead of the dialog's `document` one): Tab stays in the callout and the
 * control, and Escape ends the walkthrough only, never the dialog under it.
 * The one exception is an Escape meant for a control's open list: it is left
 * to the control and marked handled, which `Modal` honours.
 *
 * MOVING BETWEEN THE PAGE AND A DIALOG. Each step's control is looked for
 * wherever it is, and the layer follows it: a step on the page after one in a
 * dialog (or the other way round, or in another dialog) carries on there. If
 * the dialog holding the current step goes away, the walkthrough looks for
 * that step's control or the next step's, the lazy way (up to `waitMs`), and
 * carries on with whichever shows; if neither does, it ends as skipped. The
 * intro ends as skipped with its dialog; the closing card moves to the page.
 * Only on the page does the walkthrough hold the page's scroll, by a property
 * no dialog touches (`./page-lock`), so the two never undo each other.
 *
 * ANOTHER DIALOG ON TOP. While a modal dialog that is not the walkthrough's
 * own (a confirm or a form the step's control opened) is open, the
 * walkthrough steps aside: nothing drawn, no keys taken, no hold on the
 * page's scroll, no waits running out and no step moving on. The dialog's
 * Escape and Tab are its own. When it closes, the walkthrough picks up on the
 * same step: measured again, focus as the step's mode has it, and a condition
 * that came to hold meanwhile moves the step on then.
 *
 * ENDING. The last step done is `completed` (after the closing card, if there
 * is one); "not now", the end button, Escape and "Don't show this again" are
 * `skipped`.
 *
 * Copy: the client gives every key, resolved from the catalogue's root. Step
 * copy, the intro's body and wait lines get an `input` value, `touch` or
 * `mouse`, so a message can say "Tap" or "Click" with an ICU select.
 *
 * Layer: `z-40`, above the shell's sticky header (10), the phone tab bar (20)
 * and the conversation drawer (30), and under the dialog layer (`Modal`,
 * `Sheet` and toasts at 50). Inside a dialog it is above the dialog's content.
 */

export type SpotlightProps = {
    /** Every step, in order. */
    steps: readonly SpotlightStep[];
    /** An opening card before the first step. */
    intro?: SpotlightIntro;
    /** A closing card after the last step. */
    done?: SpotlightDone;
    /** How the walkthrough ended (see ENDING above). Called once. */
    onDismiss: (outcome: TutorialOutcome) => void;
    /** Nothing was ever shown: no control to point at. */
    onUnavailable: () => void;
    /** Named on the root element (`data-spotlight`). */
    name: string;
    /** `start` (default) or `lazy`; see FINDING THE CONTROLS above. */
    resolve?: 'start' | 'lazy';
    /** Lazy: how long a step waits for its control before it is skipped, in ms. */
    waitMs?: number;
    /** The counter's key, given `current` and `total`. Defaults to `tutorial.common.counter`. */
    counterKey?: string;
    /** The callout's end button. Defaults to `tutorial.common.skip`. */
    endKey?: string;
    /** Offers "Don't show this again" on the intro; the walkthrough then ends as skipped. */
    onMute?: () => void;
    /**
     * Lazy: what the walkthrough runs in, when its caller opens it together
     * with the walkthrough (the post-job wizard). If it shows and goes away
     * before the first step's control does, the walkthrough is unavailable at
     * once rather than after `waitMs`.
     */
    host?: SpotlightTarget;
};

/** Lazy walkthroughs wait this long for a step's control before skipping it. */
export const DEFAULT_WAIT_MS = 8000;

type Phase =
    /** Lazy only: waiting for the first step's control before showing anything. */
    | { kind: 'locating' }
    | { kind: 'intro' }
    | { kind: 'step'; index: number }
    | { kind: 'done' };

type Layout = { hole: Box; placement: Placement };

/** The viewport, or the box the layer covers inside a dialog, in viewport px. */
type Frame = { top: number; left: number; width: number; height: number };

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

/**
 * Whether an `auto` or `action` step is done by its own condition, as asked
 * of `control` now; `wasMet` is how it stood before. As everywhere, a
 * condition that already held does not move the step on by itself.
 */
function completes(step: SpotlightStep, control: HTMLElement, wasMet: boolean): boolean {
    if ((step.mode !== 'auto' && step.mode !== 'action') || !step.advanceWhen) return false;
    return !wasMet && step.advanceWhen(control);
}

/** `touch` when the main pointer is a finger, for copy that says "Tap" rather than "Click". */
function pointerKind(): 'touch' | 'mouse' {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'mouse';
    return window.matchMedia('(pointer: coarse)')?.matches ? 'touch' : 'mouse';
}

/**
 * Runs what `check` returns as soon as it returns something: at once when it
 * already does, otherwise on the first change to the page that makes it.
 * Calls `onTimeout` instead when `ms` pass first (never, with `ms` null).
 * Returns the cancel.
 */
function waitFor(check: () => (() => void) | null, onTimeout: () => void, ms: number | null): () => void {
    const now = check();
    if (now) {
        now();
        return () => {};
    }
    let settled = false;
    const observer = new MutationObserver(() => {
        if (settled) return;
        const then = check();
        if (!then) return;
        stop();
        then();
    });
    const timer =
        ms === null
            ? null
            : setTimeout(() => {
                  if (settled) return;
                  stop();
                  onTimeout();
              }, ms);
    function stop() {
        settled = true;
        observer.disconnect();
        if (timer !== null) clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return stop;
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

export function Spotlight({
    steps: allSteps,
    intro,
    done,
    onDismiss,
    onUnavailable,
    name,
    resolve = 'start',
    waitMs = DEFAULT_WAIT_MS,
    counterKey = 'tutorial.common.counter',
    endKey = 'tutorial.common.skip',
    onMute,
    host,
}: SpotlightProps) {
    const t = useTranslations();
    const titleId = useId();
    const bodyId = useId();
    // `url(#…)` needs an id with no punctuation in it.
    const maskId = `spotlight-mask-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
    const lazy = resolve === 'lazy';
    const hasIntro = intro !== undefined;

    // The tour's steps are cut to the ones on screen as it starts, and fixed
    // from then on, so the counter's total does not move under the person.
    const [steps] = useState<readonly SpotlightStep[]>(() =>
        lazy || typeof document === 'undefined' ? allSteps : buildSteps(allSteps, isOnScreen),
    );
    const [phase, setPhase] = useState<Phase>(() =>
        lazy ? { kind: 'locating' } : intro ? { kind: 'intro' } : { kind: 'step', index: 0 },
    );
    /** Lazy: the first step's control never showed. */
    const [gaveUp, setGaveUp] = useState(false);
    const available = lazy ? !gaveUp : steps.length > 0;
    /** The current step's control, once it is on screen (lazy: nothing is drawn before). */
    const [found, setFound] = useState<HTMLElement | null>(null);
    /** Lazy: the steps the person has been shown, for the counter. */
    const [shownSteps, setShownSteps] = useState<ReadonlySet<number>>(() => new Set());
    /** Where the layer is portaled: the page, or the dialog the controls sit in. */
    const [scope, setScope] = useState<HTMLElement | null>(() =>
        lazy || typeof document === 'undefined' ? null : document.body,
    );
    const [layout, setLayout] = useState<Layout | null>(null);
    const [reducedMotion] = useState(prefersReducedMotion);
    const [pointer] = useState(pointerKind);
    // Re-draws the callout when the page changes under it: the live counter,
    // a `next` step's readiness and Back are all read from the page.
    const [, refresh] = useReducer((n: number) => n + 1, 0);

    const rootRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const primaryRef = useRef<HTMLButtonElement>(null);
    const endedRef = useRef(false);
    const phaseRef = useRef(phase);
    const scopeRef = useRef(scope);
    /** Whether the current step's `advanceWhen` held, as last asked. */
    const metRef = useRef(false);
    /** What had focus when the walkthrough first showed; undefined until then. */
    const openerRef = useRef<HTMLElement | null | undefined>(undefined);
    /** `found`, kept up to date at once: the page watchers read it between renders. */
    const controlRef = useRef<HTMLElement | null>(null);
    /** The dialog that held the current step has gone (see MOVING BETWEEN THE PAGE AND A DIALOG). */
    const orphanRef = useRef(false);
    /** The control the current step lost, and whether its condition held then. */
    const lostRef = useRef<{ at: number; control: HTMLElement; wasMet: boolean } | null>(null);
    /** Another modal dialog is open over the walkthrough (see ANOTHER DIALOG ON TOP). */
    const [suspended, setSuspended] = useState(false);
    /** `suspended`, at once: a wait that runs out before the render that holds it does not count. */
    const suspendedRef = useRef(false);
    /** Lazy: the declared host, and whether it has been on screen yet. */
    const hostRef = useRef(host);
    const hostSeenRef = useRef(false);

    const step = phase.kind === 'step' ? (steps[phase.index] ?? null) : null;
    const index = phase.kind === 'step' ? phase.index : -1;
    const shown =
        available &&
        !suspended &&
        (phase.kind === 'intro' || phase.kind === 'done' || (step !== null && (!lazy || found !== null)));
    /** Started and not over: from the intro (or first step) on, waits between steps included. */
    const running = available && phase.kind !== 'locating';
    /** Running and not stepped aside for another dialog: takes the keys and holds the page. */
    const engaged = running && !suspended;
    const inDialog = scope !== null && typeof document !== 'undefined' && scope !== document.body;

    // `scopeRef` and `controlRef` are set where their state is, so a watcher
    // never reads a value a render has not caught up with.
    useEffect(() => {
        phaseRef.current = phase;
        hostRef.current = host;
    });

    useOverlayPresence(shown);

    // Nothing to point at: the play ends without an outcome.
    useEffect(() => {
        if (!available) onUnavailable();
    }, [available, onUnavailable]);

    // The latest `onDismiss`, so `end` (and every watcher that can end the
    // walkthrough) stays the same across the host's renders: a watcher set up
    // again on a render would miss the change to the page that render made.
    const onDismissRef = useRef(onDismiss);
    useEffect(() => {
        onDismissRef.current = onDismiss;
    });
    const end = useCallback((outcome: TutorialOutcome) => {
        if (endedRef.current) return;
        endedRef.current = true;
        onDismissRef.current(outcome);
    }, []);

    /** The current step's control now: lazy ones as found, tour ones looked up afresh. */
    const controlOf = useCallback(
        (current: SpotlightStep): HTMLElement | null => {
            if (!lazy) return resolveTarget(current.target);
            return found !== null && found.isConnected ? found : null;
        },
        [lazy, found],
    );

    const show = useCallback((next: Phase) => {
        controlRef.current = null;
        setFound(null);
        setLayout(null);
        setPhase(next);
    }, []);

    const moveTo = useCallback((host: HTMLElement) => {
        scopeRef.current = host;
        setScope(host);
    }, []);

    /** Step `at` is up at `control`, wherever that is: the layer goes with it. */
    const place = useCallback(
        (at: number, control: HTMLElement) => {
            moveTo(dialogOf(control) ?? document.body);
            controlRef.current = control;
            setFound(control);
            orphanRef.current = false;
            lostRef.current = null;
            setShownSteps((seen) => (seen.has(at) ? seen : new Set(seen).add(at)));
        },
        [moveTo],
    );

    /** After the last step: the closing card, or the end. */
    const hasDone = done !== undefined;
    const finish = useCallback(() => {
        if (hasDone) show({ kind: 'done' });
        else end('completed');
    }, [hasDone, end, show]);

    /** Moves on from step `from` (-1 is the intro). Ignored when that step is no longer the current one. */
    const advanceFrom = useCallback(
        (from: number) => {
            const now = phaseRef.current;
            const at = now.kind === 'step' ? now.index : now.kind === 'intro' ? -1 : null;
            if (at !== from) return;
            // Updated at once, so a second report of the same step (an event
            // and a page change, say) is ignored.
            if (lazy) {
                const next: Phase = { kind: 'step', index: from + 1 };
                if (from + 1 < steps.length) {
                    phaseRef.current = next;
                    show(next);
                } else {
                    phaseRef.current = { kind: 'done' };
                    finish();
                }
                return;
            }
            const to = nextAvailable(steps, from, 1, isOnScreen);
            if (to !== -1) {
                phaseRef.current = { kind: 'step', index: to };
                setPhase({ kind: 'step', index: to });
            } else {
                finish();
            }
        },
        [lazy, steps, show, finish],
    );

    const goBack = useCallback(
        (from: number) => {
            const to = lazy ? previousStep(steps, from) : nextAvailable(steps, from, -1, isOnScreen);
            if (to === -1) return;
            phaseRef.current = { kind: 'step', index: to };
            if (lazy) show({ kind: 'step', index: to });
            else setPhase({ kind: 'step', index: to });
        },
        [lazy, steps, show],
    );

    // LAZY, BEFORE ANYTHING SHOWS: wait for the first step that applies to
    // have its control on screen. With a host opened together with the
    // walkthrough, that is the host being ready.
    useEffect(() => {
        if (!lazy || phase.kind !== 'locating') return;
        const first = steps.findIndex(applies);
        if (first === -1) {
            setGaveUp(true);
            return;
        }
        const begin = (control: HTMLElement) => {
            const next: Phase = hasIntro ? { kind: 'intro' } : { kind: 'step', index: first };
            phaseRef.current = next;
            setPhase(next);
            if (hasIntro) moveTo(dialogOf(control) ?? document.body);
            else place(first, control);
        };
        const check = () => {
            const control = resolveTarget(steps[first].target);
            if (control) return () => begin(control);
            // The host, once seen, going away first: the play is over.
            const declared = hostRef.current;
            if (declared === undefined) return null;
            if (resolveTarget(declared) !== null) hostSeenRef.current = true;
            else if (hostSeenRef.current) return () => setGaveUp(true);
            return null;
        };
        return waitFor(check, () => setGaveUp(true), waitMs);
    }, [lazy, phase, steps, hasIntro, waitMs, moveTo, place]);

    // LAZY, ON EACH STEP: skip it when it does not apply; otherwise find its
    // control, waiting for it when it is not there yet, and skip it if it
    // never comes. Runs again whenever the control is lost (`found` null):
    // then the step is also done if its own condition comes to hold without
    // it. After the dialog that held it went away, the next step's control
    // will do as well, and if neither shows the walkthrough ends.
    useEffect(() => {
        if (!lazy || phase.kind !== 'step' || found !== null) return;
        const at = phase.index;
        const current = steps[at];
        if (!applies(current)) {
            advanceFrom(at);
            return;
        }
        const check = (): (() => void) | null => {
            const lost = lostRef.current;
            if (lost !== null && lost.at === at && completes(current, lost.control, lost.wasMet)) {
                return () => advanceFrom(at);
            }
            const own = resolveTarget(current.target);
            if (own) return () => place(at, own);
            if (!orphanRef.current) return null;
            const next = steps.findIndex((candidate, position) => position > at && applies(candidate));
            const control = next === -1 ? null : resolveTarget(steps[next].target);
            if (!control) return null;
            return () => {
                const moved: Phase = { kind: 'step', index: next };
                phaseRef.current = moved;
                setPhase(moved);
                place(next, control);
            };
        };
        const giveUp = () => {
            // Run out while another dialog came up: held, and asked again once it closes.
            if (suspendedRef.current) return;
            if (orphanRef.current) end('skipped');
            else advanceFrom(at);
        };
        // No running out while another dialog is up: the person is busy there.
        return waitFor(check, giveUp, suspended ? null : waitMs);
    }, [lazy, phase, found, steps, waitMs, advanceFrom, place, end, suspended]);

    /** Step `at`'s control went, or stopped being drawn. */
    const lose = useCallback(
        (at: number, current: SpotlightStep, control: HTMLElement) => {
            const wasMet = metRef.current;
            // It went because the page moved on: the step is done (a submit
            // button replaced by the screen it led to).
            if (completes(current, control, wasMet)) {
                advanceFrom(at);
                return;
            }
            lostRef.current = { at, control, wasMet };
            const host = scopeRef.current;
            if (host !== null && host !== document.body && !host.isConnected) orphanRef.current = true;
            const again = resolveTarget(current.target);
            if (again) {
                place(at, again);
                return;
            }
            controlRef.current = null;
            setFound(null);
        },
        [advanceFrom, place],
    );

    // Whether the step's own condition already held when it was reached: an
    // `auto` step someone came Back to does not move on by itself until they
    // change their answer.
    useEffect(() => {
        const control = step ? controlOf(step) : null;
        metRef.current = step?.advanceWhen && control ? step.advanceWhen(control) : false;
    }, [step, controlOf]);

    // THE DIALOG WENT AWAY under the walkthrough (closed by the step's own
    // action, by its host, or by a route change). The intro ends as skipped.
    // The closing card moves to the page. A step whose control is up loses it
    // with the dialog (the page watch below calls `lose`); one still waiting
    // for its control keeps waiting, for it or the next step's, and ends the
    // walkthrough if neither shows: a play that stayed up with nothing to
    // point at would keep every other tutorial from opening.
    useEffect(() => {
        if (!inDialog || scope === null) return;
        const host = scope;
        const check = () => {
            if (host.isConnected || endedRef.current || scopeRef.current !== host) return;
            const now = phaseRef.current;
            if (now.kind === 'intro') end('skipped');
            else if (now.kind === 'done') moveTo(document.body);
            else if (now.kind === 'step' && controlRef.current === null) orphanRef.current = true;
        };
        // Asked at once too: the dialog may have gone in the render that set
        // this watcher up.
        check();
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [inDialog, scope, end, moveTo]);

    // ANOTHER DIALOG ON TOP: asked on every dialog coming or going, and when
    // the walkthrough moves (into a dialog, it is no longer another's).
    useEffect(() => {
        if (!running) return;
        const check = () => {
            const over = modalOver(scopeRef.current);
            suspendedRef.current = over;
            setSuspended(over);
        };
        check();
        const observer = new MutationObserver(check);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-modal', 'role'],
        });
        return () => observer.disconnect();
    }, [running, scope]);

    // Focus goes back to whatever had it when the walkthrough first showed,
    // or, inside a dialog whose opener has gone (the wizard moved on a
    // screen), to the dialog itself. Declared before the effect that moves
    // focus in, so it reads the opener first.
    useEffect(() => {
        if (!shown || openerRef.current !== undefined) return;
        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }, [shown]);
    useEffect(
        () => () => {
            const opener = openerRef.current;
            if (opener?.isConnected) {
                opener.focus();
                return;
            }
            const host = scopeRef.current;
            if (host && host !== document.body && host.isConnected) host.focus();
        },
        [],
    );

    // Focus into the card on each step, and back into it whenever the control
    // that had it went away.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || !shown) return;
        const active = document.activeElement;
        if (step?.mode === 'auto' || step?.mode === 'action') {
            // These steps move on from what the person does in the control
            // itself. Pulling focus into the callout would take it out of the
            // field they are typing in or the list they are picking from (a
            // combobox closes its list on blur), so focus stays where it is;
            // only focus that was lost (its button went with the last step) is
            // caught. A screen reader hears the step from the live region.
            if (!(active instanceof HTMLElement) || active === document.body || !active.isConnected) dialog.focus();
            return;
        }
        if (dialog.contains(active) && !(active instanceof HTMLButtonElement && active.disabled)) return;
        const primary = primaryRef.current;
        (primary && !primary.disabled ? primary : dialog).focus();
    }, [phase, shown, step, found, scope]);

    // The page behind stays put, as under a Modal, while the walkthrough is on
    // the page. Inside a dialog, the dialog holds the lock. Held by its own
    // property (`./page-lock`), so moving between the two in any order leaves
    // the page as the dialogs and the walkthrough each found it.
    useEffect(() => {
        if (!engaged || inDialog) return;
        return holdPageScroll();
    }, [engaged, inDialog]);

    const interactive = step !== null && isInteractive(step);

    // KEYS, at `window` capture: ahead of every `document` listener, a
    // dialog's under the walkthrough included. Escape ends the walkthrough
    // only; Tab cycles through the callout and, on an interactive step, the
    // control, and is the only Tab trap while the walkthrough is up. Also
    // while a lazy walkthrough waits between steps with nothing drawn: an
    // Escape then still ends the walkthrough, not the dialog.
    useEffect(() => {
        if (!engaged) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') {
                // Waiting, unseen, after the dialog it was in went away: the
                // walkthrough ends, and the key is left to the page.
                if (orphanRef.current) {
                    end('skipped');
                    return;
                }
                // An open list in the control closes first. The control gets
                // the key; marking it handled keeps the dialog underneath
                // from closing on it (`Modal` skips a handled Escape).
                if (ownsOpenPopup(document.activeElement)) {
                    event.preventDefault();
                    return;
                }
                event.preventDefault();
                event.stopImmediatePropagation();
                end(phaseRef.current.kind === 'done' ? 'completed' : 'skipped');
                return;
            }
            if (event.key !== 'Tab') return;
            const dialog = dialogRef.current;
            if (!dialog) return;
            const control = interactive && step ? controlOf(step) : null;
            const controlItems = control
                ? focusableWithin(control.parentElement ?? control).filter(
                      (element) => element === control || control.contains(element),
                  )
                : [];
            const items = [...controlItems, ...focusableWithin(dialog)];
            event.preventDefault();
            event.stopImmediatePropagation();
            if (items.length === 0) {
                dialog.focus();
                return;
            }
            const at = items.indexOf(document.activeElement as HTMLElement);
            const next =
                at === -1
                    ? event.shiftKey
                        ? items.length - 1
                        : 0
                    : (at + (event.shiftKey ? items.length - 1 : 1)) % items.length;
            items[next].focus();
        }
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [engaged, end, interactive, step, controlOf]);

    /** The box the layer covers: the viewport, or inside a dialog, wherever the layer's root ended up. */
    const frame = useCallback((): Frame => {
        const viewport = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
        const root = rootRef.current;
        if (!inDialog || !root) return viewport;
        // A `fixed` layer inside the dialog covers the viewport, unless the
        // dialog is a containing block for it (a transform, mid-animation):
        // then it covers the dialog. Measured, so both are right.
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return viewport;
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    }, [inDialog]);

    // Where the cutout and the callout go for the current step.
    const measure = useCallback(() => {
        const callout = dialogRef.current;
        const control = step ? controlOf(step) : null;
        if (!step || !callout || !control) {
            // A control that has gone since the step showed: the callout
            // centres itself, with no cutout, until the person moves on.
            setLayout(null);
            return;
        }
        const origin = frame();
        const local = (rect: DOMRect): Box => ({
            top: rect.top - origin.top,
            left: rect.left - origin.left,
            width: rect.width,
            height: rect.height,
        });
        const box = local(control.getBoundingClientRect());
        const popups = isInteractive(step) ? openPopupsOf(control).map((popup) => local(popup.getBoundingClientRect())) : [];
        const hole = cutoutFor(popups.length > 0 ? unionBox(box, ...popups) : box);
        let band: Band | undefined;
        if (inDialog && scope) {
            // The callout keeps to the dialog's scrolling body (clear of its
            // header and pinned footer), or to the dialog for a control
            // outside that body (a footer button).
            const body = scrollParentWithin(control, scope);
            const rect = (body ?? scope).getBoundingClientRect();
            band = { top: rect.top - origin.top, bottom: rect.bottom - origin.top };
        }
        const size = callout.getBoundingClientRect();
        const next: Layout = {
            hole,
            placement: placeCallout(
                box,
                { width: size.width, height: size.height },
                { width: origin.width, height: origin.height },
                step.placement,
                band,
                hole,
            ),
        };
        setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    }, [step, controlOf, frame, inDialog, scope]);

    // Measured before paint on every step, and again whenever the viewport,
    // a scroll position, the control or the callout changes size, or the
    // dialog it sits in finishes animating in.
    useLayoutEffect(() => {
        if (!shown || step === null) return;
        const control = controlOf(step);
        if (control) {
            const body = inDialog && scope ? scrollParentWithin(control, scope) : null;
            if (body) scrollIntoContainer(control, body);
            // Optional call: jsdom has no scrollIntoView. A fixed tab bar or a
            // sticky header is already in view, and this does nothing to them.
            else if (!inDialog) control.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
        measure();
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        const host = inDialog ? scope : null;
        host?.addEventListener('animationend', measure);
        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => measure());
            if (control) observer.observe(control);
            if (dialogRef.current) observer.observe(dialogRef.current);
            if (inDialog && rootRef.current) observer.observe(rootRef.current);
        }
        return () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
            host?.removeEventListener('animationend', measure);
            observer?.disconnect();
        };
    }, [shown, step, controlOf, inDialog, scope, measure]);

    // A step that moves on by itself, asked again on every input, change and
    // click inside its control: a value the person just typed or picked moves
    // on; a click moves on only when it is what made the condition hold (a
    // click that opens a select is not a pick). An `action` step with no
    // condition completes on a click on its control.
    useEffect(() => {
        if (suspended || step === null || (step.mode !== undefined && step.mode !== 'auto' && step.mode !== 'action')) return;
        const control = controlOf(step);
        if (!control) return;
        const at = index;
        if (step.mode === 'action') {
            if (step.advanceWhen) return;
            const onClick = () => advanceFrom(at);
            control.addEventListener('click', onClick);
            return () => control.removeEventListener('click', onClick);
        }
        const advanceWhen = step.advanceWhen;
        if (!advanceWhen) return;
        const check = (event: Event) => {
            const met = advanceWhen(control);
            const wasMet = metRef.current;
            metRef.current = met;
            if (met && (event.type !== 'click' || !wasMet)) advanceFrom(at);
        };
        for (const type of ADVANCE_EVENTS) control.addEventListener(type, check);
        return () => {
            for (const type of ADVANCE_EVENTS) control.removeEventListener(type, check);
        };
    }, [suspended, step, index, controlOf, advanceFrom]);

    // LAZY, WHILE A STEP IS UP: the page is watched. A control that went is
    // looked for again (and waited for); an `auto` or `action` step moves on
    // once its condition comes to hold (a city picked from a list sets no
    // value the control's own events report; the wizard reaching its next
    // screen is no event at all); the cutout follows an opening list; and the
    // callout is drawn again for the live counter and readiness.
    useEffect(() => {
        if (!lazy || step === null || found === null || suspended) return;
        const control = found;
        const current = step;
        const at = index;
        const root = rootRef.current;
        /** Moves the step on when its condition has just come to hold; true if it did. */
        const settled = (): boolean => {
            if (!current.advanceWhen || (current.mode !== 'auto' && current.mode !== 'action')) return false;
            const met = current.advanceWhen(control);
            const wasMet = metRef.current;
            metRef.current = met;
            if (!met || wasMet) return false;
            advanceFrom(at);
            return true;
        };
        // Asked at once too: the control may have gone, or the condition
        // come to hold, in the render that set this watcher up (or while
        // another dialog was on top).
        if (!control.isConnected || !isRendered(control)) {
            lose(at, current, control);
            return;
        }
        if (settled()) return;
        const observer = new MutationObserver((records) => {
            const now = phaseRef.current;
            if (now.kind !== 'step' || now.index !== at || controlRef.current !== control) return;
            // The walkthrough's own redraws are not the page changing.
            if (root && records.every((record) => root.contains(record.target))) return;
            if (!control.isConnected || !isRendered(control)) {
                lose(at, current, control);
                return;
            }
            if (settled()) return;
            measure();
            refresh();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        return () => observer.disconnect();
    }, [lazy, step, found, index, advanceFrom, measure, lose, suspended]);

    // Typing into a field changes no attribute: the callout is drawn again on
    // each input and change too, for a `next` step's readiness and the counter.
    useEffect(() => {
        if (step === null || step.mode === undefined) return;
        const redraw = () => refresh();
        document.addEventListener('input', redraw, true);
        document.addEventListener('change', redraw, true);
        return () => {
            document.removeEventListener('input', redraw, true);
            document.removeEventListener('change', redraw, true);
        };
    }, [step]);

    if (!available || typeof document === 'undefined' || scope === null || phase.kind === 'locating') return null;

    const values = { input: pointer };
    // A tour stop's control is looked up as it is drawn (it has no mode, so
    // nothing in the callout depends on it but a `next` step's readiness).
    const control = step === null ? null : lazy ? found : step.mode ? resolveTarget(step.target) : null;
    const hole = step && layout ? layout.hole : null;
    const placement = step && layout ? layout.placement : null;
    const transition = reducedMotion
        ? 'none'
        : 'top var(--motion-duration-slow) ease-out, left var(--motion-duration-slow) ease-out, width var(--motion-duration-slow) ease-out, height var(--motion-duration-slow) ease-out';
    const ids = { titleId, bodyId };
    const showStep = step !== null && (!lazy || found !== null);

    let callout: ReactNode = null;
    let announcement = '';
    if (suspended) {
        // Stepped aside for another dialog: nothing drawn until it closes.
    } else if (phase.kind === 'intro' && intro) {
        callout = (
            <IntroCard
                dialogRef={dialogRef}
                primaryRef={primaryRef}
                ids={ids}
                animate={!reducedMotion}
                eyebrow={intro.eyebrowKey ? t(intro.eyebrowKey) : undefined}
                title={t(intro.titleKey)}
                body={t(intro.bodyKey, values)}
                start={t(intro.startKey)}
                notNow={t(intro.notNowKey)}
                mute={onMute ? t(intro.muteKey ?? 'tutorial.help_center.mute') : undefined}
                onStart={() => advanceFrom(-1)}
                onNotNow={() => end('skipped')}
                onMute={
                    onMute
                        ? () => {
                              onMute();
                              end('skipped');
                          }
                        : undefined
                }
            />
        );
    } else if (phase.kind === 'done' && done) {
        callout = (
            <DoneCard
                dialogRef={dialogRef}
                primaryRef={primaryRef}
                ids={ids}
                animate={!reducedMotion}
                title={t(done.titleKey, values)}
                body={t(done.bodyKey, values)}
                gotIt={t('tutorial.common.got_it')}
                onGotIt={() => end('completed')}
            />
        );
    } else if (step !== null && showStep) {
        const count = lazy ? liveCount(steps, index, shownSteps) : { current: index + 1, total: steps.length };
        const last = lazy ? isLastApplicable(steps, index) : index === steps.length - 1;
        const label = t(last && !done ? 'tutorial.common.got_it' : 'tutorial.common.next');
        const ready = step.mode === undefined || isReady(step, control);
        const moveOn = () => advanceFrom(index);
        let primary: StepPrimary = null;
        if (step.mode === undefined) primary = { label, disabled: false, onClick: moveOn };
        else if (step.mode === 'next') {
            primary = {
                label,
                disabled: !ready,
                onClick: () => {
                    if (isReady(step, controlOf(step))) moveOn();
                },
            };
        } else if (step.mode === 'auto' && ready) primary = { label, disabled: false, onClick: moveOn };
        const waiting = step.mode === 'action' || (step.mode !== undefined && !ready);
        const canGoBack = lazy ? previousStep(steps, index, () => true) !== -1 : index > 0;
        const title = t(step.titleKey, values);
        const body = t(step.bodyKey, values);
        if (step.mode === 'auto' || step.mode === 'action') announcement = `${title}. ${body}`;
        callout = (
            <StepCallout
                dialogRef={dialogRef}
                primaryRef={primaryRef}
                ids={ids}
                stepId={step.id}
                interactive={interactive}
                placement={placement}
                transition={transition}
                counter={t(counterKey, count)}
                title={title}
                body={body}
                wait={waiting && step.waitKey ? t(step.waitKey, values) : undefined}
                end={t(endKey)}
                back={canGoBack ? t('tutorial.common.back') : undefined}
                primary={primary}
                onEnd={() => end('skipped')}
                onBack={() => goBack(index)}
            />
        );
    }

    return createPortal(
        <div
            ref={rootRef}
            className="pointer-events-none fixed inset-0 z-40"
            data-spotlight={name}
            data-motion={reducedMotion ? 'reduced' : 'full'}
        >
            {callout !== null ? (
                <>
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

                    {callout}
                </>
            ) : null}
            {lazy ? (
                <p className="sr-only" aria-live="polite">
                    {announcement}
                </p>
            ) : null}
        </div>,
        scope,
    );
}
