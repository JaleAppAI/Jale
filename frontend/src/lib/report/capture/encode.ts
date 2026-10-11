/**
 * Decoding and JPEG encoding for report images.
 *
 * Every image that leaves the editor or the redraw is drawn into a fresh
 * canvas and exported from it. A canvas export carries pixels only, so camera
 * metadata (location, device, time) never survives, and the orientation the
 * photo was taken in is applied while decoding.
 */
import { MASK_FILL } from './mask';

/** The longest side of any report image, in pixels. */
export const MAX_IMAGE_EDGE = 1600;
/** In-page screenshots. */
export const CAPTURE_JPEG_QUALITY = 0.8;
/** Redrawn photos and the editor's painted output. */
export const REDRAW_JPEG_QUALITY = 0.85;

/** Downscale only: the size that fits within `maxEdge` on its longest side. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    const scale = maxEdge / longest;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The pixel ratio for a capture: the screen's, lowered so the longest side fits `maxEdge`. */
export function captureScale(width: number, height: number, pixelRatio: number, maxEdge: number): number {
    const density = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    const longest = Math.max(width, height, 1);
    return Math.min(density, maxEdge / longest);
}

/** Exports a canvas as JPEG. Rejects when the browser yields nothing or another format. */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        try {
            canvas.toBlob(
                (blob) => {
                    if (!blob) reject(new Error('image_encode_failed'));
                    else if (blob.type && blob.type !== 'image/jpeg') reject(new Error('image_encode_unsupported'));
                    else resolve(blob);
                },
                'image/jpeg',
                quality,
            );
        } catch (error) {
            reject(error instanceof Error ? error : new Error('image_encode_failed'));
        }
    });
}

export interface DecodedImage {
    source: CanvasImageSource;
    width: number;
    height: number;
    /** Frees the decoded pixels. Safe to call more than once. */
    release(): void;
}

async function decodeWithBitmap(blob: Blob): Promise<DecodedImage> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
        // An engine that refuses the options object; its default orientation
        // handling applies. Bytes that are not a picture fail here as well.
        try {
            bitmap = await createImageBitmap(blob);
        } catch {
            throw new Error('image_decode_failed');
        }
    }
    if (!bitmap.width || !bitmap.height) {
        bitmap.close();
        throw new Error('image_decode_failed');
    }
    let released = false;
    return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
            if (released) return;
            released = true;
            bitmap.close();
        },
    };
}

function decodeWithElement(blob: Blob): Promise<DecodedImage> {
    return new Promise<DecodedImage>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        let settled = false;
        const fail = () => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            reject(new Error('image_decode_failed'));
        };
        img.onload = () => {
            if (settled) return;
            if (!img.naturalWidth || !img.naturalHeight) return fail();
            settled = true;
            resolve({
                source: img,
                width: img.naturalWidth,
                height: img.naturalHeight,
                release: () => URL.revokeObjectURL(url),
            });
        };
        img.onerror = fail;
        img.src = url;
    });
}

/**
 * Decodes an image file, applying its orientation. Uses `createImageBitmap`,
 * or an image element where that is missing. Rejects with
 * `image_decode_failed` when the bytes are not a picture.
 */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
    if (typeof createImageBitmap === 'function') return decodeWithBitmap(blob);
    if (typeof Image === 'undefined') throw new Error('image_decode_failed');
    return decodeWithElement(blob);
}

/** A hidden area, in the decoded image's own pixels. */
export interface PaintBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Draws a decoded image into a new canvas (white ground, longest side at most
 * `maxEdge`), paints `boxes` over it in the mask grey, and exports a JPEG.
 */
export async function renderJpeg(
    decoded: DecodedImage,
    options: { maxEdge: number; quality: number; boxes?: readonly PaintBox[] },
): Promise<{ blob: Blob; width: number; height: number }> {
    const { width, height } = fitWithin(decoded.width, decoded.height, options.maxEdge);
    const scaleX = width / decoded.width;
    const scaleY = height / decoded.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('image_encode_unsupported');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);
    if (options.boxes?.length) {
        ctx.fillStyle = MASK_FILL;
        for (const box of options.boxes) {
            ctx.fillRect(box.x * scaleX, box.y * scaleY, box.w * scaleX, box.h * scaleY);
        }
    }
    const blob = await canvasToJpeg(canvas, options.quality);
    return { blob, width, height };
}
