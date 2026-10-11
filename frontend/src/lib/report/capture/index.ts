/**
 * Report images: the in-page screenshot and the photo redraw.
 *
 * Phone browsers cannot capture the screen, so the page draws itself: the
 * capture library copies the page and renders the copy. The library is
 * loaded with a dynamic `import()` only when a capture is asked for, so it
 * never weighs on the app's own bundles.
 *
 * Masking happens on the copy BEFORE anything is embedded or drawn (see
 * mask.ts). In the library (modern-screenshot 4.7.0, dist/index.mjs,
 * `domToForeignObjectSvg`): `cloneNode` calls `filter(child)` in
 * `appendChildNode` before each child is copied, and `onCloneEachNode` after
 * each copy; then `onCloneNode(copy)` runs, and only after it
 * `embedWebFont` and `embedNode` -- the only places the library fetches
 * anything (`contextFetch`) -- and finally the render. A refused element is
 * never copied, so its image, video or frame is never loaded, fetched or
 * embedded. `onCreateForeignObjectSvg` then cleans the copy's style sheet,
 * before the render: every image its pseudo-element rules draw goes, data URLs
 * included, the embedded fonts stay, and any CSS address that was not
 * embedded goes too.
 */
import {
    CAPTURE_JPEG_QUALITY,
    MAX_IMAGE_EDGE,
    REDRAW_JPEG_QUALITY,
    canvasToJpeg,
    captureScale,
    decodeImage,
    renderJpeg,
} from './encode';
import { createCaptureMask, scrubStyleSheets, type CloneMap } from './mask';

export type CaptureResult =
    | { ok: true; image: Blob; width: number; height: number; ms: number }
    | { ok: false; reason: 'timeout' | 'failed' | 'unsupported'; ms: number };

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Redraws a photo through a canvas and returns a JPEG (quality 0.85, longest
 * side at most `maxEdge`), whatever its size, so its metadata never leaves
 * the phone and its orientation is applied. Rejects when the file does
 * not decode as an image.
 */
export async function redrawImage(file: Blob, o: { maxEdge?: number } = {}): Promise<Blob> {
    const maxEdge = o.maxEdge ?? MAX_IMAGE_EDGE;
    if (!Number.isFinite(maxEdge) || maxEdge < 1) throw new RangeError('maxEdge must be a positive number');
    const decoded = await decodeImage(file);
    try {
        const { blob } = await renderJpeg(decoded, { maxEdge, quality: REDRAW_JPEG_QUALITY });
        return blob;
    } finally {
        decoded.release();
    }
}

/* ---------------- the viewport ---------------- */

/** What the person sees, measured on the live page just before it is copied. */
interface ViewportSnapshot {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    /** Sticky elements: how far they sit from their place in the page flow. */
    sticky: Map<Element, { dx: number; dy: number }>;
    /** Scrolled boxes other than the page itself. */
    scrolled: Map<Element, { x: number; y: number }>;
    /** The body's overflow belongs to the page (it scrolls or locks the viewport). */
    bodyOverflowIsViewport: boolean;
    background: string;
}

function isTransparent(color: string): boolean {
    const value = color.trim().toLowerCase();
    return !value || value === 'transparent' || /^rgba\(.*,\s*0(?:\.0+)?\)$/.test(value) || /\/\s*0(?:\.0+)?\)$/.test(value);
}

/** Elements outside excluded areas (the report sheet is never measured). */
function* visibleElements(doc: Document): Generator<Element> {
    const walker = doc.createTreeWalker(doc.documentElement, 1 /* SHOW_ELEMENT */, {
        acceptNode: (node) => ((node as Element).hasAttribute('data-capture-exclude') ? 2 /* REJECT */ : 1 /* ACCEPT */),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node as Element;
}

/**
 * Where a sticky element sits relative to its place in the flow. Measured by
 * setting it static for one synchronous read and restoring its exact style
 * attribute; nothing is painted in between, and a sticky box keeps its flow
 * space either way, so nothing else moves.
 */
function stickyOffset(el: HTMLElement): { dx: number; dy: number } {
    const shown = el.getBoundingClientRect();
    const attribute = el.getAttribute('style');
    let flow: DOMRect;
    try {
        el.style.setProperty('position', 'static', 'important');
        flow = el.getBoundingClientRect();
    } finally {
        if (attribute === null) el.removeAttribute('style');
        else el.setAttribute('style', attribute);
    }
    return { dx: shown.left - flow.left, dy: shown.top - flow.top };
}

function snapshotViewport(doc: Document, win: Window): ViewportSnapshot {
    const root = doc.documentElement;
    const scroller = doc.scrollingElement ?? root;
    const width = root.clientWidth || win.innerWidth;
    const height = win.innerHeight || root.clientHeight;

    const stickyElements: HTMLElement[] = [];
    const scrolled = new Map<Element, { x: number; y: number }>();
    for (const el of visibleElements(doc)) {
        const position = win.getComputedStyle(el).position;
        if ((position === 'sticky' || position === '-webkit-sticky') && 'style' in el) stickyElements.push(el as HTMLElement);
        if (el !== scroller && el !== root && (el.scrollTop || el.scrollLeft)) {
            scrolled.set(el, { x: el.scrollLeft, y: el.scrollTop });
        }
    }
    // All reads above, then the writes: one layout per sticky element.
    const sticky = new Map<Element, { dx: number; dy: number }>();
    for (const el of stickyElements) {
        const offset = stickyOffset(el);
        if (offset.dx || offset.dy) sticky.set(el, offset);
    }

    const rootStyle = win.getComputedStyle(root);
    const bodyOverflowIsViewport = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible';
    const bodyColor = doc.body ? win.getComputedStyle(doc.body).backgroundColor : '';
    const background = !isTransparent(bodyColor) ? bodyColor : !isTransparent(rootStyle.backgroundColor) ? rootStyle.backgroundColor : '#ffffff';

    return {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        scrollX: win.scrollX || 0,
        scrollY: win.scrollY || 0,
        sticky,
        scrolled,
        bodyOverflowIsViewport,
        background,
    };
}

function styleOf(node: Node | undefined): CSSStyleDeclaration | null {
    const style = (node as HTMLElement | undefined)?.style;
    return style && typeof style.setProperty === 'function' ? style : null;
}

/**
 * Moves the copy so the rendered area is the visible viewport: the page is
 * shifted by the scroll position, fixed elements stay where the screen shows
 * them, stuck elements are put where they are stuck, and scrolled boxes show
 * the part that is scrolled into view.
 */
function placeViewport(doc: Document, copyRoot: Node, map: CloneMap, snap: ViewportSnapshot): void {
    const root = styleOf(copyRoot);
    if (root) {
        // Relative, so content positioned against the page moves with it;
        // fixed content keeps the frame of the image itself.
        root.setProperty('position', 'relative', 'important');
        root.setProperty('margin-top', `${-snap.scrollY}px`, 'important');
        root.setProperty('margin-left', `${-snap.scrollX}px`, 'important');
        root.setProperty('overflow', 'visible', 'important');
    }
    if (doc.body && snap.bodyOverflowIsViewport) {
        styleOf(map.cloneOf(doc.body))?.setProperty('overflow', 'visible', 'important');
    }
    for (const [el, { dx, dy }] of snap.sticky) {
        const style = styleOf(map.cloneOf(el));
        if (!style) continue;
        style.setProperty('position', 'relative', 'important');
        style.setProperty('top', `${dy}px`, 'important');
        style.setProperty('left', `${dx}px`, 'important');
        style.setProperty('bottom', 'auto', 'important');
        style.setProperty('right', 'auto', 'important');
    }
    for (const [el, { x, y }] of snap.scrolled) {
        const copy = map.cloneOf(el) as Element | undefined;
        if (!copy || copy.hasAttribute?.('data-capture-masked')) continue;
        for (const child of Array.from(copy.children)) {
            const style = styleOf(child);
            if (!style) continue;
            const current = style.getPropertyValue('transform');
            const shift = `translate(${-x}px, ${-y}px)`;
            style.setProperty('transform', current && current !== 'none' ? `${shift} ${current}` : shift);
        }
    }
}

/* ---------------- the capture ---------------- */

class Unsupported extends Error {}

function now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function canDraw(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (typeof XMLSerializer === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false;
    if (typeof HTMLCanvasElement.prototype.toBlob !== 'function') return false;
    try {
        return document.createElement('canvas').getContext('2d') !== null;
    } catch {
        return false;
    }
}

async function drawViewport(budgetMs: number): Promise<{ image: Blob; width: number; height: number }> {
    let lib: typeof import('modern-screenshot');
    try {
        lib = await import('modern-screenshot');
    } catch {
        throw new Unsupported('capture_library_unavailable');
    }

    const doc = document;
    const snap = snapshotViewport(doc, window);
    const mask = createCaptureMask(doc.documentElement);
    const scale = captureScale(snap.width, snap.height, window.devicePixelRatio, MAX_IMAGE_EDGE);

    // The context is created on a bare element, so the library does not wait
    // for every image on the page to load (`createContext` waits for the
    // images under the node it is given). Masked images are never drawn, and
    // kept ones are fetched when they are embedded. The page is then set as
    // the node to copy.
    const context = await lib.createContext(doc.createElement('div'), {
        width: snap.width,
        height: snap.height,
        scale,
        type: 'image/jpeg',
        quality: CAPTURE_JPEG_QUALITY,
        backgroundColor: snap.background,
        timeout: Math.max(250, budgetMs),
        filter: (node) => mask.filter(node),
        onCloneEachNode: (copy) => mask.onCloneEachNode(copy),
        onCloneNode: (copy) => {
            const map = mask.apply(copy);
            placeViewport(doc, copy, map, snap);
        },
        onCreateForeignObjectSvg: (svg) => scrubStyleSheets(svg),
    });
    try {
        (context as { node: Node }).node = doc.documentElement;
        const canvas = await lib.domToCanvas(context);
        const image = await canvasToJpeg(canvas, CAPTURE_JPEG_QUALITY);
        return { image, width: canvas.width, height: canvas.height };
    } finally {
        lib.destroyContext(context);
    }
}

/**
 * Draws the visible part of the page, at its current scroll position, with
 * every private field, form value and uploaded image hidden before anything
 * is drawn. Never throws: a slow capture reports `timeout`, a failing one
 * `failed`, and a browser without a canvas or the library `unsupported`.
 */
export async function captureViewport(o: { timeoutMs?: number } = {}): Promise<CaptureResult> {
    const started = now();
    const elapsed = () => Math.max(0, Math.round(now() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeoutMs = typeof o?.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
        if (!canDraw()) return { ok: false, reason: 'unsupported', ms: elapsed() };

        const work = drawViewport(timeoutMs);
        // The library cannot be stopped; a late result or error is dropped.
        work.catch(() => {});
        const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([work, timedOut]);
        if (outcome === 'timeout') return { ok: false, reason: 'timeout', ms: elapsed() };
        return { ok: true, image: outcome.image, width: outcome.width, height: outcome.height, ms: elapsed() };
    } catch (error) {
        return { ok: false, reason: error instanceof Unsupported ? 'unsupported' : 'failed', ms: elapsed() };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
