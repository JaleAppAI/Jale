import { vi } from 'vitest';

/**
 * A recording stand-in for the 2D canvas, so the encoding paths can be tested
 * without a native canvas. It records the drawing calls in order, with the
 * fill colour in force at each `fillRect`, and every `toBlob` request.
 */
export interface CanvasCall {
    op: 'fillRect' | 'drawImage' | 'clearRect';
    args: unknown[];
    fillStyle?: string;
    canvas: HTMLCanvasElement;
}

export interface CanvasMock {
    calls: CanvasCall[];
    toBlobCalls: Array<{ canvas: HTMLCanvasElement; type: string | undefined; quality: unknown; blob: Blob | null }>;
    /** What `toBlob` hands back next; `null` makes the encode fail. */
    nextBlob: (type: string | undefined) => Blob | null;
    /** Delay, in ms, before each `toBlob` callback (0: next macrotask). */
    toBlobDelayMs: number;
    restore(): void;
}

export function installCanvasMock(): CanvasMock {
    const mock: CanvasMock = {
        calls: [],
        toBlobCalls: [],
        nextBlob: (type) => new Blob([`encoded-${Math.random()}`], { type: type ?? 'image/png' }),
        toBlobDelayMs: 0,
        restore: () => {},
    };

    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
        return recordingContext(this);
    } as unknown as HTMLCanvasElement['getContext']);

    function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
        const ctx = {
            canvas,
            fillStyle: '#000000',
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'low',
            fillRect: (...args: unknown[]) => mock.calls.push({ op: 'fillRect', args, fillStyle: String(ctx.fillStyle), canvas }),
            clearRect: (...args: unknown[]) => mock.calls.push({ op: 'clearRect', args, canvas }),
            drawImage: (...args: unknown[]) => mock.calls.push({ op: 'drawImage', args, canvas }),
        };
        return ctx as unknown as CanvasRenderingContext2D;
    }

    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
        this: HTMLCanvasElement,
        callback: BlobCallback,
        type?: string,
        quality?: unknown,
    ) {
        const blob = mock.nextBlob(type);
        mock.toBlobCalls.push({ canvas: this, type, quality, blob });
        setTimeout(() => callback(blob), mock.toBlobDelayMs);
    });

    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:,');

    mock.restore = () => {
        getContext.mockRestore();
        toBlob.mockRestore();
        toDataURL.mockRestore();
    };
    return mock;
}

/** A decodable stand-in for `createImageBitmap`: sizes come from the blob's text ("img:WxH"). */
export function installImageBitmapMock(): { closed: number; restore(): void } {
    const state = { closed: 0, restore: () => {} };
    const original = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(async (blob: Blob) => {
        const text = await blob.text();
        const match = /^img:(\d+)x(\d+)/.exec(text);
        if (!match) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
        return { width: Number(match[1]), height: Number(match[2]), close: () => { state.closed += 1; } };
    });
    state.restore = () => {
        (globalThis as { createImageBitmap?: unknown }).createImageBitmap = original;
    };
    return state;
}

/** A fake image file the bitmap mock decodes to `width` x `height`. */
export function fakeImage(width: number, height: number, type = 'image/jpeg'): Blob {
    return new Blob([`img:${width}x${height}`], { type });
}
