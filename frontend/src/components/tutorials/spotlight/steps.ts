import type { Side } from './geometry';

/**
 * A spotlight walkthrough's steps are DATA: what to point at, what to say
 * (message keys, resolved by the engine from the catalogue's root), and how
 * the step behaves. The engine (`./Spotlight`) owns no copy; each client (the
 * app tour, a later task walkthrough) keeps its step list in its own module.
 */

/**
 * What a step points at:
 *  - `{ nav }`: a navigation link by its `data-nav-key` (the keys in
 *    `components/layout/nav-config.ts`);
 *  - `{ tour }`: a control marked with `data-tour`;
 *  - `{ selector }`: any CSS selector;
 *  - a function returning the element, for anything a selector cannot say.
 * Where a selector matches several elements (the desktop sidebar and the
 * phone tab bar both carry `data-nav-key`), the first one that is actually
 * rendered is used, so a step follows whichever copy the screen shows.
 */
export type SpotlightTarget = { nav: string } | { tour: string } | { selector: string } | (() => Element | null);

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
     * step is up. Off by default: the control is shown, not offered.
     */
    interactive?: boolean;
    /**
     * Moves on by itself once this returns true. The engine asks again on
     * every `input`, `change` and `click` inside the target, so a step can
     * advance once the person has typed or picked something. Pair it with
     * `interactive`.
     */
    advanceWhen?: (target: Element) => boolean;
};

/** An optional opening card: no cutout, a start button and a "not now". */
export type SpotlightIntro = {
    titleKey: string;
    bodyKey: string;
    startKey: string;
    notNowKey: string;
};

export function targetSelector(target: Exclude<SpotlightTarget, () => Element | null>): string {
    if ('nav' in target) return `[data-nav-key="${target.nav}"]`;
    if ('tour' in target) return `[data-tour="${target.tour}"]`;
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
