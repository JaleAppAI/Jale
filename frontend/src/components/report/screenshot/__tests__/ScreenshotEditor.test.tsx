import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScreenshotEditor, type ScreenshotEditorLabels } from '../ScreenshotEditor';
import { MASK_FILL } from '@/lib/report/capture/mask';
import {
    fakeImage,
    installCanvasMock,
    installImageBitmapMock,
    type CanvasMock,
} from '@/lib/report/capture/__tests__/canvas-mock';

const LABELS: ScreenshotEditorLabels = {
    previewAlt: 'Screenshot of the page',
    maskedNote: 'Grey areas are hidden for you',
    hideArea: 'Hide an area',
    done: 'Done',
    undo: 'Undo',
    remove: 'Remove image',
    boxLabel: 'Hidden area {n}',
    keyboardHint: 'Enter adds an area. Arrows move it, Shift and arrows resize it, Delete removes it.',
    deleteBox: 'Delete this area',
};

// The image decodes to 800 x 600 and is shown at 400 x 300: one screen pixel is two image pixels.
const W = 800;
const H = 600;
let canvas: CanvasMock;
let bitmaps: ReturnType<typeof installImageBitmapMock>;
let original: Blob;
let onChange: ReturnType<typeof vi.fn<(b: Blob | null) => void>>;
let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
/** Every callback, in order: 'busy:true', 'change:painted', 'change:original', 'change:null', 'busy:false'. */
let log: string[];

beforeEach(() => {
    canvas = installCanvasMock();
    bitmaps = installImageBitmapMock();
    original = fakeImage(W, H);
    log = [];
    onChange = vi.fn((b: Blob | null) => {
        log.push(b === null ? 'change:null' : b === original ? 'change:original' : 'change:painted');
    });
    onBusyChange = vi.fn((busy: boolean) => {
        log.push(`busy:${busy}`);
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
    canvas.restore();
    bitmaps.restore();
    vi.restoreAllMocks();
});

async function setup() {
    const utils = render(<ScreenshotEditor image={original} onChange={onChange} onBusyChange={onBusyChange} labels={LABELS} />);
    // Wait for the decode: the hide-an-area control is enabled once the size is known.
    await waitFor(() => expect(screen.getByRole('button', { name: LABELS.hideArea })).toBeEnabled());
    return utils;
}

function enterHideMode() {
    fireEvent.click(screen.getByRole('button', { name: LABELS.hideArea }));
    return screen.getByRole('button', { name: LABELS.hideArea, description: LABELS.keyboardHint });
}

/** Box fills of the most recent paint, as [x, y, w, h] in image pixels. */
function lastPaint(): number[][] {
    const last = canvas.toBlobCalls[canvas.toBlobCalls.length - 1];
    return canvas.calls
        .filter((c) => c.canvas === last.canvas && c.op === 'fillRect' && c.fillStyle === MASK_FILL)
        .map((c) => (c.args as number[]).map((n) => Math.round(n)));
}

async function settle() {
    await waitFor(() => expect(log[log.length - 1]).toBe('busy:false'));
}

function tap(el: Element, x: number, y: number) {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'touch' });
    fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'touch' });
}

function drag(el: Element, from: [number, number], to: [number, number]) {
    fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], pointerId: 1, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(el, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1], pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], pointerId: 1, button: 0, pointerType: 'mouse' });
}

describe('ScreenshotEditor', () => {
    it('shows the preview with its description and the masking note, and emits nothing on its own', async () => {
        await setup();
        expect(screen.getByRole('img', { name: LABELS.previewAlt })).toBeInTheDocument();
        expect(screen.getByText(LABELS.maskedNote)).toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
        expect(onBusyChange).not.toHaveBeenCalled();
    });

    it('places a box with a tap and emits the image painted with it', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50); // image (200, 100)
        expect(screen.getByRole('group', { name: 'Hidden area 1' })).toBeInTheDocument();
        await settle();
        expect(log).toEqual(['busy:true', 'change:painted', 'busy:false']);
        // Default box: half the short side wide, 15% tall, centred on the tap.
        expect(lastPaint()).toEqual([[50, 55, 300, 90]]);
        const painted = onChange.mock.calls[0][0];
        expect(painted).toBe(canvas.toBlobCalls[canvas.toBlobCalls.length - 1].blob);
        expect(canvas.toBlobCalls[canvas.toBlobCalls.length - 1]).toMatchObject({ type: 'image/jpeg', quality: 0.85 });
    });

    it('draws a box with a drag', async () => {
        await setup();
        const surface = enterHideMode();
        drag(surface, [20, 20], [120, 70]);
        await settle();
        expect(lastPaint()).toEqual([[40, 40, 200, 100]]);
    });

    it('places, moves, resizes and deletes a box with the keyboard', async () => {
        await setup();
        const surface = enterHideMode();
        surface.focus();
        fireEvent.keyDown(surface, { key: 'Enter' });
        const box = screen.getByRole('group', { name: 'Hidden area 1' });
        await waitFor(() => expect(box).toHaveFocus());
        await settle();
        expect(lastPaint()).toEqual([[250, 255, 300, 90]]);

        fireEvent.keyDown(box, { key: 'ArrowRight' });
        await settle();
        expect(lastPaint()).toEqual([[262, 255, 300, 90]]);

        fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true });
        await settle();
        expect(lastPaint()).toEqual([[262, 255, 300, 102]]);

        fireEvent.keyDown(box, { key: 'ArrowLeft', shiftKey: true });
        await settle();
        expect(lastPaint()).toEqual([[262, 255, 288, 102]]);

        fireEvent.keyDown(box, { key: 'Delete' });
        expect(screen.queryByRole('group', { name: 'Hidden area 1' })).toBeNull();
        // No area is hidden any more: the image handed in is the image again, at once.
        expect(onChange.mock.lastCall?.[0]).toBe(original);
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });

    it('moves a box by dragging it, and resizes it by its handle', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        const box = screen.getByRole('group', { name: 'Hidden area 1' });
        drag(box, [100, 50], [110, 60]); // +20, +20 image pixels
        await settle();
        expect(lastPaint()).toEqual([[70, 75, 300, 90]]);

        const handle = box.querySelector('[data-resize-handle]')!;
        drag(handle, [250, 80], [260, 100]); // +20 wide, +40 tall
        await settle();
        expect(lastPaint()).toEqual([[70, 75, 320, 130]]);
    });

    it('keeps every box inside the image', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 395, 295);
        await settle();
        const [[x, y, w, h]] = lastPaint();
        expect(x + w).toBeLessThanOrEqual(W);
        expect(y + h).toBeLessThanOrEqual(H);
        const box = screen.getByRole('group', { name: 'Hidden area 1' });
        drag(box, [390, 290], [600, 500]);
        await settle();
        const [[x2, y2, w2, h2]] = lastPaint();
        expect([x2 + w2, y2 + h2]).toEqual([W, H]);
    });

    it('paints every box into each emitted image', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        tap(surface, 300, 250);
        await settle();
        expect(lastPaint()).toHaveLength(2);
    });

    it('undoes the last change, back to the image handed in', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        tap(surface, 300, 250);
        await settle();
        const undo = screen.getByRole('button', { name: LABELS.undo });
        fireEvent.click(undo);
        await settle();
        expect(lastPaint()).toEqual([[50, 55, 300, 90]]);
        expect(screen.queryByRole('group', { name: 'Hidden area 2' })).toBeNull();
        fireEvent.click(undo);
        expect(onChange.mock.lastCall?.[0]).toBe(original);
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(undo).toBeDisabled();
    });

    it('removes the image', async () => {
        await setup();
        fireEvent.click(screen.getByRole('button', { name: LABELS.remove }));
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('stays busy until the painted image is emitted', async () => {
        await setup();
        canvas.toBlobDelayMs = 40;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        expect(onBusyChange).toHaveBeenLastCalledWith(true);
        expect(onChange).not.toHaveBeenCalled();
        await settle();
        expect(log).toEqual(['busy:true', 'change:painted', 'busy:false']);
    });

    it('is busy from the start of a drag, before the gesture ends', async () => {
        await setup();
        const surface = enterHideMode();
        fireEvent.pointerDown(surface, { clientX: 20, clientY: 20, pointerId: 1, button: 0, pointerType: 'mouse' });
        expect(onBusyChange).toHaveBeenLastCalledWith(true);
        fireEvent.pointerCancel(surface, { pointerId: 1 });
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('stays busy through a drag that starts while an earlier repaint is still running', async () => {
        // Box A is placed and its repaint starts; box B is pressed and dragged
        // before that repaint lands. Landing must not release Send: the grey
        // draft of B is on screen, but B is not in the image yet.
        await setup();
        canvas.toBlobDelayMs = 40;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        fireEvent.pointerDown(surface, { clientX: 250, clientY: 150, pointerId: 2, button: 0, pointerType: 'mouse' });
        fireEvent.pointerMove(surface, { clientX: 320, clientY: 220, pointerId: 2, pointerType: 'mouse' });
        const dragStart = log.length;

        await waitFor(() => expect(log).toContain('change:painted'));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 60));
        });
        expect(onBusyChange).toHaveBeenLastCalledWith(true);
        // A's image was still handed on: box A never waits for B.
        expect(onChange.mock.lastCall?.[0]).toBe(canvas.toBlobCalls[0].blob);

        fireEvent.pointerUp(surface, { clientX: 320, clientY: 220, pointerId: 2, button: 0, pointerType: 'mouse' });
        await settle();
        expect(lastPaint()).toHaveLength(2);
        expect(log.slice(dragStart).filter((e) => e === 'busy:false')).toHaveLength(1);
    });

    it('releases a held drag that changes nothing, keeping the image already painted', async () => {
        await setup();
        canvas.toBlobDelayMs = 40;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        fireEvent.pointerDown(surface, { clientX: 250, clientY: 150, pointerId: 2, button: 0, pointerType: 'mouse' });
        await waitFor(() => expect(log).toContain('change:painted'));
        expect(onBusyChange).toHaveBeenLastCalledWith(true);

        fireEvent.pointerCancel(surface, { pointerId: 2 });
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(onChange.mock.lastCall?.[0]).toBe(canvas.toBlobCalls[0].blob);
        expect(log.filter((e) => e.startsWith('change:'))).toEqual(['change:painted']);
    });

    it('ends a gesture whose pointer capture is lost, so busy clears', async () => {
        await setup();
        const surface = enterHideMode();
        fireEvent.pointerDown(surface, { clientX: 20, clientY: 20, pointerId: 7, button: 0, pointerType: 'touch' });
        expect(onBusyChange).toHaveBeenLastCalledWith(true);
        fireEvent(surface, new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 7 }));
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('never emits the uncovered image while a box exists, even when changes overlap a paint', async () => {
        await setup();
        canvas.toBlobDelayMs = 30;
        const surface = enterHideMode();
        surface.focus();
        fireEvent.keyDown(surface, { key: 'Enter' });
        const box = screen.getByRole('group', { name: 'Hidden area 1' });
        // Three changes while the first paint is still running.
        fireEvent.keyDown(box, { key: 'ArrowRight' });
        fireEvent.keyDown(box, { key: 'ArrowRight' });
        fireEvent.keyDown(box, { key: 'ArrowDown' });
        await settle();
        expect(log.filter((e) => e.startsWith('change:'))).not.toContain('change:original');
        // Busy never dropped in between, and the last image has the last position.
        expect(log.filter((e) => e === 'busy:false')).toHaveLength(1);
        expect(lastPaint()).toEqual([[274, 267, 300, 90]]);
        expect(onChange.mock.lastCall?.[0]).toBe(canvas.toBlobCalls[canvas.toBlobCalls.length - 1].blob);
    });

    it('drops a paint that finishes after the areas were undone', async () => {
        await setup();
        canvas.toBlobDelayMs = 40;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        fireEvent.click(screen.getByRole('button', { name: LABELS.undo }));
        expect(onChange.mock.lastCall?.[0]).toBe(original);
        await act(async () => {
            await new Promise((r) => setTimeout(r, 80));
        });
        expect(log).toEqual(['busy:true', 'change:original', 'busy:false']);
    });

    it('starts fresh for a new image', async () => {
        const { rerender } = await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        const next = fakeImage(400, 300);
        rerender(<ScreenshotEditor image={next} onChange={onChange} onBusyChange={onBusyChange} labels={LABELS} />);
        await waitFor(() => expect(screen.getByRole('button', { name: LABELS.hideArea })).toBeEnabled());
        expect(document.querySelectorAll('[data-hidden-area]')).toHaveLength(0);
        expect(screen.getByRole('button', { name: LABELS.undo })).toBeDisabled();
    });

    it('removes the image rather than leave it uncovered when a repaint fails', async () => {
        await setup();
        canvas.nextBlob = () => null;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        expect(log).toEqual(['busy:true', 'change:null', 'busy:false']);
    });

    it('removes the image when it cannot be decoded, as it would after a failed repaint', async () => {
        const unreadable = new Blob(['not-an-image'], { type: 'image/jpeg' });
        render(<ScreenshotEditor image={unreadable} onChange={onChange} onBusyChange={onBusyChange} labels={LABELS} />);
        await waitFor(() => expect(log).toEqual(['change:null']));
        expect(screen.getByRole('button', { name: LABELS.hideArea })).toBeDisabled();
    });

    it('ignores a failed decode of an image that was already replaced', async () => {
        const unreadable = new Blob(['not-an-image'], { type: 'image/jpeg' });
        const { rerender } = render(
            <ScreenshotEditor image={unreadable} onChange={onChange} onBusyChange={onBusyChange} labels={LABELS} />,
        );
        rerender(<ScreenshotEditor image={original} onChange={onChange} onBusyChange={onBusyChange} labels={LABELS} />);
        await waitFor(() => expect(screen.getByRole('button', { name: LABELS.hideArea })).toBeEnabled());
        expect(log).toEqual([]);
    });

    it('clears busy when it goes away mid-paint, and emits nothing afterwards', async () => {
        const { unmount } = await setup();
        canvas.toBlobDelayMs = 40;
        const surface = enterHideMode();
        tap(surface, 100, 50);
        unmount();
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        await act(async () => {
            await new Promise((r) => setTimeout(r, 80));
        });
        expect(onChange).not.toHaveBeenCalled();
        expect(bitmaps.closed).toBe(1);
    });

    it('leaves the hide mode on Done and keeps showing the hidden areas', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        fireEvent.click(screen.getByRole('button', { name: LABELS.done }));
        expect(screen.queryByRole('button', { name: LABELS.hideArea, description: LABELS.keyboardHint })).toBeNull();
        expect(screen.queryByRole('group', { name: 'Hidden area 1' })).toBeNull();
        expect(document.querySelectorAll('[data-hidden-area]')).toHaveLength(1);
        expect(screen.getByRole('button', { name: LABELS.hideArea })).toBeInTheDocument();
    });

    it('labels each box and gives its controls 44px hit areas', async () => {
        await setup();
        const surface = enterHideMode();
        tap(surface, 100, 50);
        await settle();
        tap(surface, 300, 250);
        await settle();
        expect(screen.getByRole('group', { name: 'Hidden area 2' })).toHaveAccessibleDescription(LABELS.keyboardHint);
        const deletes = screen.getAllByRole('button', { name: LABELS.deleteBox });
        expect(deletes).toHaveLength(2);
        for (const control of [...deletes, ...Array.from(document.querySelectorAll('[data-resize-handle]'))]) {
            expect(control.className).toMatch(/\bh-11\b/);
            expect(control.className).toMatch(/\bw-11\b/);
        }
        fireEvent.click(deletes[0]);
        await settle();
        expect(screen.getAllByRole('group')).toHaveLength(1);
        expect(lastPaint()).toEqual([[450, 455, 300, 90]]);
    });
});
