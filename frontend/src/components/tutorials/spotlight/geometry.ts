/**
 * Where a spotlight's cutout and callout go, in viewport pixels. Pure, so the
 * placement rules are tested without a layout engine.
 */

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
/** A vertical stretch of the viewport, top and bottom edges in px. */
export type Band = { top: number; bottom: number };
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
 *
 * `band` narrows the vertical room the callout may use (inside a dialog: its
 * scrolling body, so the callout keeps off the header and the pinned footer).
 * Without it the band is the whole viewport, as for the app tour. Sideways the
 * callout always has the whole viewport.
 *
 * `hole` is the cutout to keep clear when it is bigger than the target's own
 * (a combobox whose list is open); the arrow still points at the target.
 *
 * `outer` is the room the callout may take when it fits on no side within
 * `band` (inside a dialog: the whole panel or viewport, over the dialog's
 * header or footer), rather than be drawn over the cutout. Without it the
 * callout never leaves the band.
 */
export function placeCallout(
    target: Box,
    callout: Size,
    viewport: Size,
    hint?: Side,
    band: Band = { top: 0, bottom: viewport.height },
    hole: Box = cutoutFor(target),
    outer: Band = band,
): Placement {
    const holeBottom = hole.top + hole.height;
    const holeRight = hole.left + hole.width;
    const centerX = target.left + target.width / 2;
    const centerY = target.top + target.height / 2;

    const fitsIn = (room: Band): Record<Side, boolean> => ({
        top: hole.top - CALLOUT_GAP - callout.height >= room.top + VIEWPORT_GUTTER,
        bottom: holeBottom + CALLOUT_GAP + callout.height <= room.bottom - VIEWPORT_GUTTER,
        right:
            holeRight + CALLOUT_GAP + callout.width <= viewport.width - VIEWPORT_GUTTER &&
            callout.height <= room.bottom - room.top - VIEWPORT_GUTTER * 2,
    });
    // The band first; past it only when nothing fits there.
    let room = band;
    let fits = fitsIn(band);
    if (!fits.top && !fits.bottom && !fits.right) {
        room = outer;
        fits = fitsIn(outer);
    }
    const roomHeight = room.bottom - room.top;
    const inLeftRail = centerX < viewport.width / 3 && target.width < viewport.width / 3;

    let side: Side;
    if (hint && fits[hint]) side = hint;
    else if (centerY - room.top > roomHeight * 0.6 && fits.top) side = 'top';
    else if (inLeftRail && fits.right) side = 'right';
    else if (fits.bottom) side = 'bottom';
    else if (fits.top) side = 'top';
    else if (fits.right) side = 'right';
    else side = room.bottom - holeBottom >= hole.top - room.top ? 'bottom' : 'top';

    const minTop = room.top + VIEWPORT_GUTTER;
    const maxTop = room.bottom - VIEWPORT_GUTTER - callout.height;
    const maxLeft = viewport.width - VIEWPORT_GUTTER - callout.width;

    if (side === 'right') {
        const top = clamp(centerY - callout.height / 2, minTop, maxTop);
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
        top: clamp(rawTop, minTop, maxTop),
        left,
        arrow: clamp(centerX - left, ARROW_INSET, callout.width - ARROW_INSET),
    };
}

/** The smallest box holding every box given (the first when there is one). */
export function unionBox(first: Box, ...rest: Box[]): Box {
    let top = first.top;
    let left = first.left;
    let bottom = first.top + first.height;
    let right = first.left + first.width;
    for (const box of rest) {
        top = Math.min(top, box.top);
        left = Math.min(left, box.left);
        bottom = Math.max(bottom, box.top + box.height);
        right = Math.max(right, box.left + box.width);
    }
    return { top, left, width: right - left, height: bottom - top };
}

/**
 * The part of `hole` inside `band`: what a dialog's scrolling body shows of
 * a cutout, so the ring is not drawn over the dialog's header or footer.
 * The whole hole when none of it is inside.
 */
export function clipToBand(hole: Box, band: Band): Box {
    const top = Math.max(hole.top, band.top);
    const bottom = Math.min(hole.top + hole.height, band.bottom);
    if (bottom <= top) return hole;
    return { top, left: hole.left, width: hole.width, height: bottom - top };
}

/** How far a scrolling box can scroll from where it is: `min` up (negative), `max` down. */
export type ScrollRange = { min: number; max: number };

/**
 * How far to scroll a dialog's body (positive: its content moves up) so a
 * cutout and its callout both fit in `band`, the callout above or below the
 * cutout: the smallest scroll in `range` that does it. A cutout taller than
 * the band gets room for the callout above its top, or else below its
 * bottom. 0 when nothing needs to move, or nothing in `range` helps.
 */
export function scrollToFit(hole: Box, calloutHeight: number, band: Band, range: ScrollRange): number {
    const need = calloutHeight + CALLOUT_GAP + VIEWPORT_GUTTER;
    const holeBottom = hole.top + hole.height;
    // Each way, as the scrolls that do it: [from, to].
    const ways: Array<[number, number]> =
        hole.height + need <= band.bottom - band.top
            ? [
                  // The callout above it, the cutout's bottom still in the band.
                  [holeBottom - band.bottom, hole.top - band.top - need],
                  // The callout below it, the cutout's top still in the band.
                  [holeBottom + need - band.bottom, hole.top - band.top],
              ]
            : [
                  // Taller than the band: its top under the callout, or else its bottom over it.
                  [hole.top - band.top - need, hole.top - band.top - need],
                  [holeBottom + need - band.bottom, holeBottom + need - band.bottom],
              ];
    let best: number | null = null;
    for (const [from, to] of ways) {
        const lo = Math.max(from, range.min);
        const hi = Math.min(to, range.max);
        if (lo > hi) continue;
        const scroll = lo > 0 ? lo : hi < 0 ? hi : 0;
        if (hole.height + need > band.bottom - band.top) return scroll;
        if (best === null || Math.abs(scroll) < Math.abs(best)) best = scroll;
    }
    return best ?? 0;
}
