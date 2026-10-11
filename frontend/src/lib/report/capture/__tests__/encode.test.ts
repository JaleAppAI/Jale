// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureScale, canvasToJpeg, fitWithin, renderJpeg, decodeImage, MAX_IMAGE_EDGE } from '../encode';
import { redrawImage } from '../index';
import { MASK_FILL } from '../mask';
import { fakeImage, installCanvasMock, installImageBitmapMock, type CanvasMock } from './canvas-mock';

let canvas: CanvasMock;
let bitmaps: ReturnType<typeof installImageBitmapMock>;

beforeEach(() => {
    canvas = installCanvasMock();
    bitmaps = installImageBitmapMock();
});

afterEach(() => {
    canvas.restore();
    bitmaps.restore();
});

describe('fitWithin', () => {
    it('keeps an image that already fits', () => {
        expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    });
    it('scales the longest side down to the limit, keeping the shape', () => {
        expect(fitWithin(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 });
        expect(fitWithin(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 });
    });
    it('never returns a zero side', () => {
        expect(fitWithin(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
    });
});

describe('captureScale', () => {
    it('uses the screen density while the image stays within the limit', () => {
        expect(captureScale(400, 300, 2, 1600)).toBe(2);
    });
    it('lowers the density so the longest side is at most the limit', () => {
        const scale = captureScale(390, 844, 3, 1600);
        expect(Math.floor(844 * scale)).toBeLessThanOrEqual(1600);
        expect(scale).toBeCloseTo(1600 / 844, 5);
    });
    it('falls back to 1 for a missing density', () => {
        expect(captureScale(400, 300, Number.NaN, 1600)).toBe(1);
        expect(captureScale(400, 300, 0, 1600)).toBe(1);
    });
});

describe('canvasToJpeg', () => {
    it('asks the canvas for a JPEG at the given quality', async () => {
        const c = document.createElement('canvas');
        const blob = await canvasToJpeg(c, 0.8);
        expect(canvas.toBlobCalls).toHaveLength(1);
        expect(canvas.toBlobCalls[0]).toMatchObject({ type: 'image/jpeg', quality: 0.8 });
        expect(blob).toBe(canvas.toBlobCalls[0].blob);
    });
    it('rejects when the canvas yields nothing', async () => {
        canvas.nextBlob = () => null;
        await expect(canvasToJpeg(document.createElement('canvas'), 0.8)).rejects.toThrow(/encode/);
    });
    it('rejects when the browser falls back to another format', async () => {
        canvas.nextBlob = () => new Blob(['x'], { type: 'image/png' });
        await expect(canvasToJpeg(document.createElement('canvas'), 0.8)).rejects.toThrow(/encode/);
    });
});

describe('renderJpeg', () => {
    it('paints the boxes solid, scaled with the image', async () => {
        const decoded = await decodeImage(fakeImage(3200, 1600));
        const out = await renderJpeg(decoded, { maxEdge: 1600, quality: 0.85, boxes: [{ x: 100, y: 200, w: 400, h: 100 }] });
        expect(out).toMatchObject({ width: 1600, height: 800 });
        const boxFills = canvas.calls.filter((c) => c.op === 'fillRect' && c.fillStyle === MASK_FILL);
        expect(boxFills.map((c) => c.args)).toEqual([[50, 100, 200, 50]]);
        // The boxes go on after the picture.
        const order = canvas.calls.map((c) => (c.op === 'fillRect' && c.fillStyle === MASK_FILL ? 'box' : c.op));
        expect(order.indexOf('drawImage')).toBeLessThan(order.indexOf('box'));
    });
});

describe('redrawImage', () => {
    it('re-encodes a small image too: drawn through a canvas and exported as JPEG 0.85', async () => {
        const input = fakeImage(40, 30, 'image/png');
        const out = await redrawImage(input);
        const draws = canvas.calls.filter((c) => c.op === 'drawImage');
        expect(draws).toHaveLength(1);
        expect(draws[0].args.slice(1)).toEqual([0, 0, 40, 30]);
        expect(canvas.toBlobCalls).toHaveLength(1);
        expect(canvas.toBlobCalls[0]).toMatchObject({ type: 'image/jpeg', quality: 0.85 });
        expect(out).toBe(canvas.toBlobCalls[0].blob);
        expect(out).not.toBe(input);
    });

    it('caps the longest side at 1600 by default, and at the given edge', async () => {
        await redrawImage(fakeImage(4000, 3000));
        expect(canvas.toBlobCalls[0].canvas.width).toBe(MAX_IMAGE_EDGE);
        expect(canvas.toBlobCalls[0].canvas.height).toBe(1200);
        await redrawImage(fakeImage(4000, 3000), { maxEdge: 800 });
        expect(canvas.toBlobCalls[1].canvas.width).toBe(800);
        expect(canvas.toBlobCalls[1].canvas.height).toBe(600);
    });

    it('fills a white ground first, so transparent areas do not turn black in a JPEG', async () => {
        await redrawImage(fakeImage(10, 10, 'image/png'));
        const first = canvas.calls[0];
        expect(first.op).toBe('fillRect');
        expect(first.fillStyle?.toLowerCase()).toBe('#ffffff');
    });

    it('releases the decoded image', async () => {
        await redrawImage(fakeImage(10, 10));
        expect(bitmaps.closed).toBe(1);
    });

    it('rejects an input that does not decode', async () => {
        await expect(redrawImage(new Blob(['not an image'], { type: 'image/jpeg' }))).rejects.toThrow(/decode/);
        expect(canvas.toBlobCalls).toHaveLength(0);
    });

    it('rejects a nonsensical edge', async () => {
        await expect(redrawImage(fakeImage(10, 10), { maxEdge: 0 })).rejects.toThrow(RangeError);
        await expect(redrawImage(fakeImage(10, 10), { maxEdge: Number.NaN })).rejects.toThrow(RangeError);
    });
});
