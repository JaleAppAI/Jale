import type { Side } from './geometry';

/**
 * A spotlight walkthrough's steps are DATA: what to point at, what to say
 * (message keys, resolved by the engine from the catalogue's root), and how
 * the step behaves. The engine (`./Spotlight`) owns no copy; each client (the
 * app tour, a task walkthrough under `../guides`) keeps its step list in its
 * own module.
 */

/**
 * What a step points at:
 *  - `{ nav }`: a navigation link by its `data-nav-key` (the keys in
 *    `components/layout/nav-config.ts`);
 *  - `{ tour }`: a control marked with `data-tour`;
 *  - `{ guide }`: a control marked with `data-guide`, the task walkthroughs'
 *    hook, named `<flow>.<name>` (`post.title`, `post.city`, ...);
 *  - `{ selector }`: any CSS selector;
 *  - a function returning the element, for anything a selector cannot say.
 * Where a selector matches several elements (the desktop sidebar and the
 * phone tab bar both carry `data-nav-key`), the first one that is actually
 * rendered is used, so a step follows whichever copy the screen shows.
 */
export type SpotlightTarget =
    | { nav: string }
    | { tour: string }
    | { guide: string }
    | { selector: string }
    | (() => Element | null);

/**
 * How a task walkthrough's step moves on (a step with no mode is a tour stop:
 * its Next is always enabled and the control is shown, not offered).
 *  - `next`: a Next button, disabled until `ready(target)` holds.
 *  - `auto`: moves on by itself once `advanceWhen(target)` holds, after the
 *    person types, picks or taps in the control. Next shows once `ready`
 *    holds, as a fallback (and for a person who came Back to the step).
 *  - `action`: no Next. The wait line says what to do, and the step completes
 *    when the person clicks the control, or, when `advanceWhen` is given,
 *    only once it holds (a submit button the page may refuse completes when
 *    the page has really moved on, not on the click).
 * Every mode makes the step interactive unless `interactive: false` says not.
 */
export type StepMode = 'next' | 'auto' | 'action';

export type SpotlightStep = {
    /** Stable name: React keys, `data-step`, tests. */
    id: string;
    target: SpotlightTarget;
    titleKey: string;
    bodyKey: string;
    /** A preferred side for the callout, used when it fits (see `placeCallout`). */
    placement?: Side;
    /**
     * The cutout lets the pointer through, and Tab reaches the target, so the
     * person can click, type into or pick from the real control while the
     * step is up. Off by default for a tour stop, on for a step with a `mode`.
     */
    interactive?: boolean;
    /**
     * Moves on by itself once this returns true. The engine asks again on
     * every `input`, `change` and `click` inside the target (and, in a lazy
     * walkthrough, on every change to the page), so a step can advance once
     * the person has typed or picked something.
     */
    advanceWhen?: (target: Element) => boolean;
    /** How the step moves on; see `StepMode`. */
    mode?: StepMode;
    /**
     * Lazy walkthroughs only: whether the step applies now. Asked when the
     * step is reached (false skips it) and for the live counter. Example:
     * "type your trade" only while Other is picked.
     */
    when?: () => boolean;
    /** `next` and `auto` steps: when the step's Next may be pressed. Defaults to `advanceWhen`, else always. */
    ready?: (target: Element) => boolean;
    /** The line that says what the step is waiting for, shown until it is ready (always, on an `action` step). */
    waitKey?: string;
};

/** An optional opening card: no cutout, a start button, a "not now" and, when offered, "Don't show this again". */
export type SpotlightIntro = {
    titleKey: string;
    bodyKey: string;
    startKey: string;
    notNowKey: string;
    /** A short line above the title naming the walkthrough. */
    eyebrowKey?: string;
    /** The mute button's label, shown only when the engine is given `onMute`. */
    muteKey?: string;
};

/** An optional closing card after the last step: a title, a sentence and Got it. */
export type SpotlightDone = {
    titleKey: string;
    bodyKey: string;
};

export function guideSelector(name: string): string {
    return `[data-guide="${name}"]`;
}

export function targetSelector(target: Exclude<SpotlightTarget, () => Element | null>): string {
    if ('nav' in target) return `[data-nav-key="${target.nav}"]`;
    if ('tour' in target) return `[data-tour="${target.tour}"]`;
    if ('guide' in target) return guideSelector(target.guide);
    return target.selector;
}

/** Rendered: laid out at all (an ancestor with `display: none` gives no boxes). */
export function isRendered(element: Element): boolean {
    return element.getClientRects().length > 0;
}

/** The element `target` names, if it is on screen now; null otherwise. */
export function resolveTarget(target: SpotlightTarget, root: ParentNode = document): HTMLElement | null {
    if (typeof target === 'function') {
        const element = target();
        return element instanceof HTMLElement && isRendered(element) ? element : null;
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(targetSelector(target)))) {
        if (isRendered(element)) return element;
    }
    return null;
}

/** The first rendered control marked `data-guide="<name>"`, or null. For a guide's own conditions. */
export function guideTarget(name: string): HTMLElement | null {
    return resolveTarget({ guide: name });
}

/** Whether the pointer and Tab reach the step's control. */
export function isInteractive(step: SpotlightStep): boolean {
    return step.interactive ?? step.mode !== undefined;
}

/** Whether a lazy walkthrough's step applies now (see `when`). */
export function applies(step: SpotlightStep): boolean {
    return step.when ? step.when() : true;
}

/** Whether a `next` or `auto` step's Next may be pressed now. */
export function isReady(step: SpotlightStep, target: Element | null): boolean {
    if (target === null) return false;
    const ready = step.ready ?? step.advanceWhen;
    return ready ? ready(target) : true;
}

/** The steps whose element is on screen now, in order. */
export function buildSteps<T extends SpotlightStep>(steps: readonly T[], available: (step: T) => boolean): T[] {
    return steps.filter(available);
}

/**
 * From `from`, the next step in `direction` whose element is still on screen,
 * or -1 when there is none: a step whose element has gone since the
 * walkthrough started is passed over.
 */
export function nextAvailable<T extends SpotlightStep>(
    steps: readonly T[],
    from: number,
    direction: 1 | -1,
    available: (step: T) => boolean,
): number {
    for (let index = from + direction; index >= 0 && index < steps.length; index += direction) {
        if (available(steps[index])) return index;
    }
    return -1;
}

/**
 * Lazy walkthroughs: the step Back returns to from `from`, or -1. It is the
 * nearest earlier step that applies and whose control is on screen, and Back
 * never crosses an `action` step: that step was completed by doing something
 * in the page (moving to the wizard's next screen, say) that Back cannot undo.
 */
export function previousStep(
    steps: readonly SpotlightStep[],
    from: number,
    onScreen: (step: SpotlightStep) => boolean = (step) => resolveTarget(step.target) !== null,
): number {
    for (let index = from - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (step.mode === 'action') return -1;
        if (!applies(step)) continue;
        if (onScreen(step)) return index;
    }
    return -1;
}

/**
 * Lazy walkthroughs: "{current} of {total}". Behind the current step it counts
 * the steps the person was shown (`shown`); from it on, the steps that apply
 * now. A passed step's condition is not asked again: its control may be gone
 * (the wizard's first screen, once on the second), and the count must not
 * shrink for that.
 */
export function liveCount(
    steps: readonly SpotlightStep[],
    index: number,
    shown: ReadonlySet<number>,
): { current: number; total: number } {
    let current = 0;
    let total = 0;
    steps.forEach((step, at) => {
        const counts = at < index ? shown.has(at) : at === index || applies(step);
        if (!counts) return;
        total += 1;
        if (at <= index) current += 1;
    });
    return { current, total };
}

/** Lazy walkthroughs: whether no later step applies now, so this one's button finishes. */
export function isLastApplicable(steps: readonly SpotlightStep[], index: number): boolean {
    for (let at = index + 1; at < steps.length; at += 1) {
        if (applies(steps[at])) return false;
    }
    return true;
}
