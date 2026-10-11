/**
 * Geometry of the hidden areas, in the image's own pixels. Every result is
 * whole pixels, at least the minimum size, and inside the image.
 */

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface HiddenArea extends Rect {
    id: number;
}

function shortSide(width: number, height: number): number {
    return Math.max(1, Math.min(width, height));
}

/** The smallest area, so a box can always be seen and grabbed. */
export function minSide(width: number, height: number): number {
    return Math.max(8, Math.round(shortSide(width, height) * 0.04));
}

/** One arrow-key step. */
export function keyStep(width: number, height: number): number {
    return Math.max(1, Math.round(shortSide(width, height) * 0.02));
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Keeps a rectangle whole, at least the minimum size, and inside the image. */
export function fit(rect: Rect, width: number, height: number): Rect {
    const min = minSide(width, height);
    const w = Math.round(clamp(rect.w, Math.min(min, width), width));
    const h = Math.round(clamp(rect.h, Math.min(min, height), height));
    return {
        x: Math.round(clamp(rect.x, 0, width - w)),
        y: Math.round(clamp(rect.y, 0, height - h)),
        w,
        h,
    };
}

/** The area placed by a tap or by the keyboard: half the short side wide, 15% tall, centred. */
export function defaultArea(cx: number, cy: number, width: number, height: number): Rect {
    const side = shortSide(width, height);
    const w = Math.round(side * 0.5);
    const h = Math.round(side * 0.15);
    return fit({ x: cx - w / 2, y: cy - h / 2, w, h }, width, height);
}

/** The area spanned by a drag between two points. */
export function spanArea(x1: number, y1: number, x2: number, y2: number, width: number, height: number): Rect {
    const left = clamp(Math.min(x1, x2), 0, width);
    const top = clamp(Math.min(y1, y2), 0, height);
    const right = clamp(Math.max(x1, x2), 0, width);
    const bottom = clamp(Math.max(y1, y2), 0, height);
    return fit({ x: left, y: top, w: right - left, h: bottom - top }, width, height);
}

export function moveArea(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
    return fit({ ...rect, x: rect.x + dx, y: rect.y + dy }, width, height);
}

/** Grows or shrinks from the top-left corner, which stays put. */
export function resizeArea(rect: Rect, dw: number, dh: number, width: number, height: number): Rect {
    const min = minSide(width, height);
    const w = clamp(rect.w + dw, Math.min(min, width), width - rect.x);
    const h = clamp(rect.h + dh, Math.min(min, height), height - rect.y);
    return fit({ ...rect, w, h }, width, height);
}

export function sameRect(a: Rect, b: Rect): boolean {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
