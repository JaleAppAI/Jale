/**
 * Where a spotlight's cutout and callout go, in viewport pixels. Pure, so the
 * placement rules are tested without a layout engine.
 */

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
/** Which side of the target the callout sits on. */
export type Side = 'top' | 'bottom' | 'right';
export type Placement = {
    side: Side;
    top: number;
    left: number;
    /**
     * Where the arrow points, measured along the callout edge that faces the
     * target: from its left edge for `top`/`bottom`, from its top edge for
     * `right`.
     */
    arrow: number;
};

/** The callout never comes closer than this to the viewport's edges. */
export const VIEWPORT_GUTTER = 16;
/** Space between the target and the edge of the cutout around it. */
export const CUTOUT_PAD = 6;
/** Space between the cutout and the callout (the arrow sits in it). */
export const CALLOUT_GAP = 14;
/** The arrow keeps clear of the callout's rounded corners. */
export const ARROW_INSET = 22;

function clamp(value: number, min: number, max: number): number {
    // On a screen too small for the callout, the start edge wins.
    return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** The cutout drawn around `target`. */
export function cutoutFor(target: Box): Box {
    return {
        top: target.top - CUTOUT_PAD,
        left: target.left - CUTOUT_PAD,
        width: target.width + CUTOUT_PAD * 2,
        height: target.height + CUTOUT_PAD * 2,
    };
}

/**
 * Where the callout goes for a target.
 *
 *  - A step's `hint` wins when the callout fits on that side.
 *  - Otherwise: a target in the lower part of the screen (the phone tab bar)
 *    gets it ABOVE; a narrow target at the left (the desktop sidebar) to its
 *    RIGHT, when it fits there; anything else (a header button) BELOW, or
 *    above when below has no room.
 *
 * The callout then slides along that side to stay inside the viewport, and the
 * arrow follows the target's centre.
 */
export function placeCallout(target: Box, callout: Size, viewport: Size, hint?: Side): Placement {
    const hole = cutoutFor(target);
    const holeBottom = hole.top + hole.height;
    const holeRight = hole.left + hole.width;
    const centerX = target.left + target.width / 2;
    const centerY = target.top + target.height / 2;

    const fits: Record<Side, boolean> = {
        top: hole.top - CALLOUT_GAP - callout.height >= VIEWPORT_GUTTER,
        bottom: holeBottom + CALLOUT_GAP + callout.height <= viewport.height - VIEWPORT_GUTTER,
        right: holeRight + CALLOUT_GAP + callout.width <= viewport.width - VIEWPORT_GUTTER,
    };
    const inLeftRail = centerX < viewport.width / 3 && target.width < viewport.width / 3;

    let side: Side;
    if (hint && fits[hint]) side = hint;
    else if (centerY > viewport.height * 0.6 && fits.top) side = 'top';
    else if (inLeftRail && fits.right) side = 'right';
    else if (fits.bottom) side = 'bottom';
    else if (fits.top) side = 'top';
    else side = viewport.height - holeBottom >= hole.top ? 'bottom' : 'top';

    const maxTop = viewport.height - VIEWPORT_GUTTER - callout.height;
    const maxLeft = viewport.width - VIEWPORT_GUTTER - callout.width;

    if (side === 'right') {
        const top = clamp(centerY - callout.height / 2, VIEWPORT_GUTTER, maxTop);
        return {
            side,
            top,
            left: holeRight + CALLOUT_GAP,
            arrow: clamp(centerY - top, ARROW_INSET, callout.height - ARROW_INSET),
        };
    }

    const left = clamp(centerX - callout.width / 2, VIEWPORT_GUTTER, maxLeft);
    const rawTop = side === 'bottom' ? holeBottom + CALLOUT_GAP : hole.top - CALLOUT_GAP - callout.height;
    return {
        side,
        top: clamp(rawTop, VIEWPORT_GUTTER, maxTop),
        left,
        arrow: clamp(centerX - left, ARROW_INSET, callout.width - ARROW_INSET),
    };
}
