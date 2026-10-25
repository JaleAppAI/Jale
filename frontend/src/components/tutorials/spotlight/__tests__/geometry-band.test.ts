import { describe, expect, it } from 'vitest';
import {
    CALLOUT_GAP,
    CUTOUT_PAD,
    VIEWPORT_GUTTER,
    clipToBand,
    cutoutFor,
    placeCallout,
    scrollToFit,
    unionBox,
    type Band,
    type Box,
    type Placement,
    type Size,
} from '../geometry';

/*
 * Placement inside a dialog: the callout keeps to a vertical band (the
 * dialog's scrolling body, clear of its pinned footer), and keeps clear of a
 * cutout bigger than the target (a combobox with its list open).
 */

const viewport = { width: 390, height: 844 };
const callout = { width: 326, height: 180 };

describe('placeCallout with a band', () => {
    it('goes below the target when the band has room there', () => {
        const target = { top: 200, left: 30, width: 330, height: 70 };
        const placement = placeCallout(target, callout, viewport, undefined, { top: 90, bottom: 740 });
        expect(placement.side).toBe('bottom');
        expect(placement.top).toBe(200 + 70 + CUTOUT_PAD + CALLOUT_GAP);
    });

    it('goes above when below would run into the footer, though the viewport has room', () => {
        const target = { top: 540, left: 30, width: 330, height: 70 };
        // Without the band it would sit below, as asked (the viewport reaches 844).
        expect(placeCallout(target, callout, viewport, 'bottom').side).toBe('bottom');
        const inBand = placeCallout(target, callout, viewport, 'bottom', { top: 90, bottom: 740 });
        expect(inBand.side).toBe('top');
        expect(inBand.top + callout.height).toBeLessThanOrEqual(540 - CUTOUT_PAD - CALLOUT_GAP);
    });

    it('never leaves the band, even when neither side fits', () => {
        const target = { top: 120, left: 30, width: 330, height: 500 };
        const placement = placeCallout(target, callout, viewport, undefined, { top: 90, bottom: 740 });
        expect(placement.top).toBeGreaterThanOrEqual(90 + VIEWPORT_GUTTER);
        expect(placement.top + callout.height).toBeLessThanOrEqual(740 - VIEWPORT_GUTTER);
    });

    it('keeps clear of an open list under the field, and still points at the field', () => {
        const field = { top: 330, left: 30, width: 330, height: 44 };
        const list = { top: 380, left: 30, width: 330, height: 256 };
        const hole = cutoutFor(unionBox(field, list));
        const placement = placeCallout(field, callout, viewport, 'bottom', { top: 90, bottom: 740 }, hole);
        // Below the list would leave the band; above the field fits.
        expect(placement.side).toBe('top');
        expect(placement.top + callout.height).toBeLessThanOrEqual(field.top - CUTOUT_PAD - CALLOUT_GAP);
    });
});

describe('unionBox', () => {
    it('is the smallest box around all of them', () => {
        expect(unionBox({ top: 10, left: 20, width: 100, height: 40 }, { top: 60, left: 10, width: 50, height: 100 })).toEqual({
            top: 10,
            left: 10,
            width: 110,
            height: 150,
        });
    });
});

/** How far the callout runs into the ring, the smaller of across and down: 0 when they do not meet. */
function overlap(placement: Placement, size: Size, ring: Box): number {
    const across = Math.min(placement.left + size.width, ring.left + ring.width) - Math.max(placement.left, ring.left);
    const down = Math.min(placement.top + size.height, ring.top + ring.height) - Math.max(placement.top, ring.top);
    return Math.max(0, Math.min(across, down));
}

/** A step in a dialog as the engine lays it out: scrolled to fit when it can, the ring clipped to the body. */
function lay(target: Box, size: Size, viewport: Size, band: Band, range: { min: number; max: number }) {
    const scroll = scrollToFit(cutoutFor(target), size.height, band, range);
    const moved = { ...target, top: target.top - scroll };
    const ring = clipToBand(cutoutFor(moved), band);
    const placement = placeCallout(moved, size, viewport, undefined, band, ring, { top: 0, bottom: viewport.height });
    return { scroll, ring, placement };
}

describe('a callout never over its own cutout inside a dialog', () => {
    const phone = { width: 390, height: 844 };
    const desk = { width: 1280, height: 800 };
    const tall = { width: 326, height: 220 };

    it('a button in a body that cannot scroll, with no room in it (the posted screen’s share): over the footer instead', () => {
        const share = { top: 300, left: 330, width: 590, height: 50 };
        const band = { top: 250, bottom: 450 };
        const { scroll, ring, placement } = lay(share, { width: 360, height: 200 }, desk, band, { min: 0, max: 0 });
        expect(scroll).toBe(0);
        expect(overlap(placement, { width: 360, height: 200 }, ring)).toBeLessThanOrEqual(4);
        expect(placement.top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
        expect(placement.top + 200).toBeLessThanOrEqual(desk.height - VIEWPORT_GUTTER);
    });

    it('a field at the bottom of the body (pay): the body scrolls the least that fits the callout above it', () => {
        const pay = { top: 640, left: 30, width: 330, height: 60 };
        const band = { top: 120, bottom: 700 };
        const { scroll, ring, placement } = lay(pay, tall, phone, band, { min: -400, max: 300 });
        expect(scroll).toBe(706 - 700);
        expect(placement.side).toBe('top');
        expect(overlap(placement, tall, ring)).toBeLessThanOrEqual(4);
        expect(placement.top).toBeGreaterThanOrEqual(band.top + VIEWPORT_GUTTER);
    });

    it('a body scrolled midway, the field half under the header (questions): scrolled back the least, the callout below', () => {
        const questions = { top: 106, left: 30, width: 330, height: 68 };
        const band = { top: 120, bottom: 700 };
        const { scroll, ring, placement } = lay(questions, tall, phone, band, { min: -300, max: 500 });
        expect(scroll).toBe(100 - 120);
        expect(placement.side).toBe('bottom');
        expect(overlap(placement, tall, ring)).toBeLessThanOrEqual(4);
        expect(placement.top + tall.height).toBeLessThanOrEqual(band.bottom - VIEWPORT_GUTTER);
    });

    it('a section taller than the body (requirements): the callout beside the part in view, the ring kept to the body', () => {
        const requirements = { top: 150, left: 30, width: 330, height: 900 };
        const band = { top: 120, bottom: 700 };
        const { ring, placement } = lay(requirements, tall, phone, band, { min: -50, max: 800 });
        expect(ring.top).toBeGreaterThanOrEqual(band.top);
        expect(ring.top + ring.height).toBeLessThanOrEqual(band.bottom);
        expect(overlap(placement, tall, ring)).toBeLessThanOrEqual(4);
    });

    it('a section taller than the body that cannot scroll: the ring kept to the body, the callout past it', () => {
        const requirements = { top: 150, left: 30, width: 330, height: 900 };
        const band = { top: 120, bottom: 700 };
        const { ring, placement } = lay(requirements, { width: 326, height: 90 }, phone, band, { min: 0, max: 0 });
        expect(ring).toEqual({ top: 150 - CUTOUT_PAD, left: 30 - CUTOUT_PAD, width: 330 + CUTOUT_PAD * 2, height: 700 - (150 - CUTOUT_PAD) });
        expect(overlap(placement, { width: 326, height: 90 }, ring)).toBeLessThanOrEqual(4);
    });
});
