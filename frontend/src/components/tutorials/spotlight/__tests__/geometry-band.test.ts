import { describe, expect, it } from 'vitest';
import { CALLOUT_GAP, CUTOUT_PAD, VIEWPORT_GUTTER, cutoutFor, placeCallout, unionBox } from '../geometry';

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
