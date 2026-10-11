/**
 * The masking applied to an in-page screenshot while it is drawn.
 *
 * The page is copied node by node before anything is rendered. Every node
 * that could carry a person's details is refused BEFORE it is copied, and a
 * solid grey box of the same size takes its place in the copy. So the details
 * never exist in the copy, the drawing, or the image's pixels, and a refused
 * image or frame is never loaded or embedded.
 *
 * What is refused:
 * - `[data-capture-exclude]`, `head`, `noscript` and `template`: dropped with
 *   their subtree and no box (the report sheet, its backdrop and its toasts);
 * - `[data-private]`: a grey box, its text and children gone;
 * - `input`, `textarea`, `select` and `[contenteditable]`: a grey box;
 * - `img`, `picture`, `video`, `audio`, `canvas` and SVG `image`/`feImage`: a
 *   grey box unless the element or an ancestor carries `data-capture-safe`
 *   (brand assets only);
 * - `iframe`, `object`, `embed` and other frames: always a grey box -- a frame
 *   is never a brand asset, and copying one would load it;
 * - a CSS image (`background-image` and the other image properties) on an
 *   element that is kept: replaced by the grey fill unless capture-safe.
 *   Gradients are drawn by CSS, never loaded, and are kept;
 * - an image drawn by a pseudo-element of a kept element (the library copies
 *   pseudo-element styles into the copy's style sheet): removed, data URLs
 *   included, by `scrubStyleSheets`. The fonts embedded in that sheet stay.
 *
 * The hooks follow the copy contract of the capture library: `filter(child)`
 * is called for every child before it is copied (returning false skips it and
 * its subtree), `onCloneEachNode(copy)` after each non-text node and its
 * children are copied, and `apply(copyRoot)` once, before anything is
 * embedded or rendered. If the copy ever arrives in an order the mask did not
 * see, it throws, and the capture fails instead of guessing.
 */

/** The grey every hidden area is painted with, here and in the editor. */
export const MASK_FILL = '#9ca3af';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

export type MaskKind = 'exclude' | 'private' | 'field' | 'media' | 'keep';

/** Elements that are never part of the picture. */
const DROPPED_TAGS = new Set(['head', 'noscript', 'template']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const MEDIA_TAGS = new Set(['img', 'picture', 'video', 'audio', 'canvas']);
const SVG_MEDIA_TAGS = new Set(['image', 'feimage']);
/** Loaded documents and plugins: always hidden, whatever their marks. */
const FRAME_TAGS = new Set(['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe']);
/** Hidden elements whose tag the layout depends on keep that tag in their box. */
const STRUCTURAL_TAGS = new Set([
    'td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'caption', 'col', 'colgroup',
    'li', 'dt', 'dd', 'summary', 'legend', 'figcaption',
]);

function isElement(node: Node): node is Element {
    return node.nodeType === ELEMENT_NODE;
}

function isEditableRoot(el: Element): boolean {
    const value = el.getAttribute('contenteditable');
    return value !== null && value.trim().toLowerCase() !== 'false';
}

/** What the capture does with one node. Pure: reads the node and its ancestors only. */
export function classifyNode(node: Node): MaskKind {
    if (!isElement(node)) return 'keep';
    const el = node;
    if (el.hasAttribute('data-capture-exclude')) return 'exclude';
    const name = el.localName.toLowerCase();
    const isSvg = el.namespaceURI === SVG_NS;
    if (!isSvg && DROPPED_TAGS.has(name)) return 'exclude';
    if (el.hasAttribute('data-private')) return 'private';
    if (!isSvg && FIELD_TAGS.has(name)) return 'field';
    if (isEditableRoot(el)) return 'field';
    if (!isSvg && FRAME_TAGS.has(name)) return 'media';
    const media = isSvg ? SVG_MEDIA_TAGS.has(name) : MEDIA_TAGS.has(name);
    if (media && !el.closest('[data-capture-safe]')) return 'media';
    return 'keep';
}

/** The size and layout of an element, enough to draw a box in its place. */
export interface MaskBox {
    /** False when the element draws nothing (display: none); it then leaves no box. */
    rendered: boolean;
    width: number;
    height: number;
    /** The box's display: an inline element becomes inline-block so it keeps its size. */
    display: string;
    /** Layout properties copied onto the box (position, margins, transforms, radius...). */
    style: Record<string, string>;
    /** For an element inside an SVG: its geometry in the SVG's own units. */
    svg?: { x: number; y: number; width: number; height: number; transform: string | null } | null;
}

export type MeasureFn = (el: Element) => MaskBox;

/** Replaced elements whose bottom edge already sits on the baseline. */
const BASELINE_MEDIA = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'svg', 'iframe', 'object', 'embed']);

const NOT_RENDERED: MaskBox = { rendered: false, width: 0, height: 0, display: 'none', style: {} };

/** Copied from the element so its box sits exactly where it did. */
const LAYOUT_PROPERTIES = [
    'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'align-self', 'justify-self', 'order',
    'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
    'z-index', 'transform', 'transform-origin', 'translate', 'rotate', 'scale',
    'vertical-align', 'visibility', 'opacity',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
];

/** Measures a live element (the browser implementation of `MeasureFn`). */
export function measureElement(el: Element): MaskBox {
    const view = el.ownerDocument?.defaultView;
    if (!view || !el.isConnected) return NOT_RENDERED;
    const computed = view.getComputedStyle(el);
    if (computed.display === 'none') return NOT_RENDERED;

    if (el.namespaceURI === SVG_NS && (el as SVGElement).ownerSVGElement) {
        let bbox = { x: 0, y: 0, width: 0, height: 0 };
        try {
            const graphics = el as SVGGraphicsElement;
            if (typeof graphics.getBBox === 'function') bbox = graphics.getBBox();
        } catch {
            // An element that is not laid out has no box; the zero box stands.
        }
        return {
            rendered: true,
            width: bbox.width,
            height: bbox.height,
            display: computed.display,
            style: {},
            svg: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height, transform: el.getAttribute('transform') },
        };
    }

    let width: number;
    let height: number;
    if (computed.display === 'contents') {
        // No box of its own: cover what its children draw.
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
    } else if ('offsetWidth' in el) {
        // The untransformed size; the transform itself is copied below.
        width = (el as HTMLElement).offsetWidth;
        height = (el as HTMLElement).offsetHeight;
    } else {
        const rect = el.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
    }

    const style: Record<string, string> = {};
    for (const property of LAYOUT_PROPERTIES) {
        const value = computed.getPropertyValue(property);
        if (value) style[property] = value;
    }
    const display = computed.display === 'inline' || computed.display === 'contents' || !computed.display
        ? 'inline-block'
        : computed.display;
    // An empty inline box sits its bottom edge on the text baseline, which
    // makes the line taller than the text it replaces. Text and form fields
    // hang below the baseline, so their box is aligned to the text bottom
    // instead; images already sit on the baseline and keep it.
    if (display.startsWith('inline') && style['vertical-align'] === 'baseline' && !BASELINE_MEDIA.has(el.localName.toLowerCase())) {
        style['vertical-align'] = 'text-bottom';
    }
    return { rendered: true, width, height, display, style };
}

function buildBox(original: Element, box: MaskBox, kind: Exclude<MaskKind, 'keep' | 'exclude'>): Element {
    const doc = original.ownerDocument;
    if (box.svg) {
        const rect = doc.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(box.svg.x));
        rect.setAttribute('y', String(box.svg.y));
        rect.setAttribute('width', String(box.svg.width));
        rect.setAttribute('height', String(box.svg.height));
        if (box.svg.transform) rect.setAttribute('transform', box.svg.transform);
        rect.setAttribute('fill', MASK_FILL);
        rect.setAttribute('data-capture-masked', kind);
        return rect;
    }
    const name = original.localName.toLowerCase();
    const tag = kind === 'private' && original.namespaceURI !== SVG_NS && STRUCTURAL_TAGS.has(name) ? name : 'span';
    const el = doc.createElement(tag);
    el.setAttribute('data-capture-masked', kind);
    const style = el.style;
    for (const [property, value] of Object.entries(box.style)) {
        if (value) style.setProperty(property, value);
    }
    style.setProperty('display', box.display);
    style.setProperty('box-sizing', 'border-box');
    style.setProperty('width', `${box.width}px`);
    style.setProperty('height', `${box.height}px`);
    style.setProperty('min-width', '0px');
    style.setProperty('min-height', '0px');
    style.setProperty('max-width', 'none');
    style.setProperty('max-height', 'none');
    style.setProperty('flex-grow', '0');
    style.setProperty('flex-shrink', '0');
    style.setProperty('flex-basis', 'auto');
    style.setProperty('padding', '0px');
    style.setProperty('border-style', 'none');
    style.setProperty('overflow', 'hidden');
    style.setProperty('color', 'transparent');
    style.setProperty('background-image', 'none');
    style.setProperty('background-color', MASK_FILL);
    return el;
}

/* ---------------- CSS images on kept elements ---------------- */

/** Properties that draw a loaded image. */
const IMAGE_PROPERTIES = [
    'border-image-source', '-webkit-border-image', 'list-style-image', 'mask-image', '-webkit-mask-image',
];
const GRADIENT_LAYER = /^(?:-webkit-|-moz-)?(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;

/** Splits a CSS list on its top-level commas. */
function splitLayers(value: string): string[] {
    const layers: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            layers.push(value.slice(start, i));
            start = i + 1;
        }
    }
    layers.push(value.slice(start));
    return layers.map((layer) => layer.trim()).filter(Boolean);
}

/** True when the value draws anything other than gradients (deny by default). */
export function drawsLoadedImage(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'none' || trimmed === 'initial' || trimmed === 'unset' || trimmed === 'inherit') return false;
    return splitLayers(trimmed).some((layer) => layer !== 'none' && !(GRADIENT_LAYER.test(layer) && !/url\(/i.test(layer)));
}

function hideCssImages(original: Element, copy: Element): void {
    const style = (copy as HTMLElement).style as CSSStyleDeclaration | undefined;
    if (!style || original.closest('[data-capture-safe]')) return;
    if (drawsLoadedImage(style.getPropertyValue('background-image'))) {
        style.setProperty('background-image', 'none', style.getPropertyPriority('background-image'));
        style.setProperty('background-color', MASK_FILL, style.getPropertyPriority('background-color'));
    }
    for (const property of IMAGE_PROPERTIES) {
        if (drawsLoadedImage(style.getPropertyValue(property))) {
            style.setProperty(property, 'none', style.getPropertyPriority(property));
        }
    }
}

const UNEMBEDDED_URL = /url\(\s*(?!['"]?\s*data:)(?:"[^"]*"|'[^']*'|[^)]*)\)/gi;

/** A CSS function that draws an image, whatever its source: data URLs included. */
const IMAGE_FUNCTION = /(?:url|image|image-set|cross-fade|element|paint)\(/i;

/**
 * Scans CSS text and hands every `{ ... }` block at the top level to `block`
 * with the text in front of it; the text outside the blocks goes through
 * `outside`, told whether a block follows it, which keeps it as it is unless
 * one is given. Strings and comments are stepped over whole, so a `;`, `{` or
 * `}` inside them never splits anything.
 */
function eachBlock(
    css: string,
    block: (prelude: string, body: string) => string,
    outside: (text: string, beforeBlock: boolean) => string = (text) => text,
): string {
    let out = '';
    let segmentStart = 0;
    let depth = 0;
    let bodyStart = 0;
    let prelude = '';
    for (let i = 0; i < css.length; i += 1) {
        const ch = css[i];
        if (ch === '"' || ch === "'") {
            for (i += 1; i < css.length && css[i] !== ch; i += 1) if (css[i] === '\\') i += 1;
        } else if (ch === '/' && css[i + 1] === '*') {
            const close = css.indexOf('*/', i + 2);
            i = close === -1 ? css.length : close + 1;
        } else if (ch === '{') {
            if (depth === 0) {
                prelude = css.slice(segmentStart, i);
                bodyStart = i + 1;
            }
            depth += 1;
        } else if (ch === '}' && depth > 0) {
            depth -= 1;
            if (depth === 0) {
                out += `${outside(prelude, true)}{${block(prelude, css.slice(bodyStart, i))}}`;
                segmentStart = i + 1;
            }
        }
    }
    return out + outside(css.slice(segmentStart), false);
}

/** Whether CSS text holds a block of its own, found by the same scan, so a brace inside a string or comment never counts. */
function holdsBlock(css: string): boolean {
    let found = false;
    eachBlock(css, (_prelude, body) => {
        found = true;
        return body;
    });
    return found;
}

/** Splits declarations on the semicolons that end them (none inside strings or brackets). */
function splitDeclarations(body: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '"' || ch === "'") {
            for (i += 1; i < body.length && body[i] !== ch; i += 1) if (body[i] === '\\') i += 1;
        } else if (ch === '(') depth += 1;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) {
            parts.push(body.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(body.slice(start));
    return parts;
}

/**
 * One declaration with any image it draws taken out: the value becomes `none`
 * (for `content`, the empty string), keeping `!important`. Values without an
 * image function, gradients among them, are left as they are.
 */
function withoutImage(declaration: string): string {
    const colon = declaration.indexOf(':');
    if (colon === -1) return declaration;
    const value = declaration.slice(colon + 1);
    if (!IMAGE_FUNCTION.test(value)) return declaration;
    const name = declaration.slice(0, colon);
    const important = /!\s*important\s*$/i.test(value) ? ' !important' : '';
    return `${name}: ${name.trim().toLowerCase() === 'content' ? "''" : 'none'}${important}`;
}

/** Declarations with every image they draw taken out. */
function withoutDeclaredImages(declarations: string): string {
    return splitDeclarations(declarations).map(withoutImage).join(';');
}

/**
 * The text in front of a nested block: declarations, then that block's own
 * selector or at-rule condition after the last semicolon. Only the
 * declarations draw anything, so the images go from them; the selector or
 * condition stays as it is, and so stays valid.
 */
function withoutDeclaredImagesBefore(text: string): string {
    const parts = splitDeclarations(text);
    const prelude = parts.pop() ?? '';
    return [...parts.map(withoutImage), prelude].join(';');
}

/**
 * Takes every image out of the style rules of a copy's style sheet: the rules
 * the library writes for the pseudo-elements (and scroll bars) of the elements
 * it kept. The mask cannot see those, because the library reads them from the
 * live page's computed styles, and an image there may be a data URL that is
 * drawn without being fetched. Font rules are kept whole: the library embeds
 * the page's fonts in the same sheet, as data URLs.
 *
 * A block that holds blocks of its own is taken apart the same way, and the
 * text between its inner blocks is treated as declarations too, since a rule
 * may declare an image next to a rule nested in it; the selector or condition
 * in front of each inner block is kept whole. Any other block's body, an
 * at-rule's included, is declarations.
 */
function withoutCssImages(css: string, inBlock = false): string {
    return eachBlock(
        css,
        (prelude, body) => {
            const at = /(?:^|[;}\s])@([\w-]+)[^;]*$/.exec(prelude.trim());
            if (at?.[1].toLowerCase() === 'font-face') return body;
            return holdsBlock(body) ? withoutCssImages(body, true) : withoutDeclaredImages(body);
        },
        inBlock
            ? (text, beforeBlock) => (beforeBlock ? withoutDeclaredImagesBefore(text) : withoutDeclaredImages(text))
            : undefined,
    );
}

/**
 * Cleans the style sheets of a finished copy, which hold the styles of its
 * pseudo-elements and its embedded fonts. Every image a style rule there draws
 * is removed, data URLs included, so a pseudo-element can never paint one into
 * the picture; the fonts stay. Then every `url(...)` that was not embedded is
 * removed as well: a drawn SVG cannot load one, so nothing visible changes,
 * and no address of an image the mask hid stays in the copy.
 */
export function scrubStyleSheets(svgRoot: Element): void {
    for (const sheet of Array.from(svgRoot.querySelectorAll('style'))) {
        const text = sheet.textContent ?? '';
        const scrubbed = withoutCssImages(text).replace(UNEMBEDDED_URL, 'none');
        if (scrubbed !== text) sheet.textContent = scrubbed;
    }
}

/* ---------------- the hooks ---------------- */

/** Original node -> its copy (or, for a hidden element, its grey box). */
export interface CloneMap {
    cloneOf(original: Node): Node | undefined;
}

export interface CaptureMask {
    /** Called for each child before it is copied; false skips it and its subtree. */
    filter(node: Node): boolean;
    /** Called after each non-text node and its children are copied. */
    onCloneEachNode(copy: Node): void;
    /** Called once with the copied root, before anything is embedded or drawn. */
    apply(copyRoot: Node): CloneMap;
    /** How many elements were hidden, by kind (counts only, no content). */
    readonly counts: Readonly<Record<'private' | 'field' | 'media' | 'excluded', number>>;
}

function maskError(reason: string): Error {
    return new Error(`capture_mask_${reason}`);
}

/** A copy is the copy of `original` when it is the same kind of node with the same name. */
function isCopyOf(original: Node, copy: Node): boolean {
    if (original.nodeType !== copy.nodeType) return false;
    if (!isElement(original)) return true;
    const from = original.localName.toLowerCase();
    const to = (copy as Element).localName.toLowerCase();
    if (from === to) return true;
    // A capture-safe canvas or video is copied as a still image of itself.
    return (from === 'canvas' || from === 'video') && (to === 'img' || to === 'canvas');
}

export function createCaptureMask(root: Node, options: { measure?: MeasureFn } = {}): CaptureMask {
    const measure = options.measure ?? measureElement;
    /** Originals whose copies are still being filled; the top is the parent of the next child. */
    const open: Node[] = [root];
    /** Per parent: how many children its copy will hold so far (copies and boxes). */
    const slots = new Map<Node, number>();
    const boxes: Array<{ parent: Node; index: number; original: Element; box: Element }> = [];
    const copies = new Map<Node, Node>();
    const counts = { private: 0, field: 0, media: 0, excluded: 0 };
    let failure: Error | null = null;

    const fail = (reason: string): never => {
        failure ??= maskError(reason);
        throw failure;
    };

    return {
        counts,
        filter(node: Node): boolean {
            if (failure) throw failure;
            const parent = open[open.length - 1];
            if (!parent) return fail('order');
            if (node.nodeType === COMMENT_NODE) return false;
            const kind = classifyNode(node);
            if (kind === 'keep') {
                slots.set(parent, (slots.get(parent) ?? 0) + 1);
                if (node.nodeType !== TEXT_NODE) open.push(node);
                return true;
            }
            if (kind === 'exclude') {
                counts.excluded += 1;
                return false;
            }
            const el = node as Element;
            counts[kind] += 1;
            const measured = measure(el);
            if (measured.rendered) {
                const index = slots.get(parent) ?? 0;
                slots.set(parent, index + 1);
                boxes.push({ parent, index, original: el, box: buildBox(el, measured, kind) });
            }
            return false;
        },
        onCloneEachNode(copy: Node): void {
            if (failure) throw failure;
            const original = open.pop();
            if (!original || !isCopyOf(original, copy)) fail('order');
            copies.set(original as Node, copy);
        },
        apply(copyRoot: Node): CloneMap {
            if (failure) throw failure;
            if (open.length !== 0) fail('incomplete');
            if (copies.get(root) !== copyRoot) fail('root');
            // Pushed in copy order, so each parent's boxes arrive with rising indexes.
            for (const { parent, index, original, box } of boxes) {
                const parentCopy = copies.get(parent);
                if (!parentCopy) fail('parent');
                (parentCopy as Node).insertBefore(box, (parentCopy as Node).childNodes[index] ?? null);
                copies.set(original, box);
            }
            for (const [original, copy] of copies) {
                if (isElement(original) && isElement(copy) && !copy.hasAttribute('data-capture-masked')) {
                    hideCssImages(original, copy);
                }
            }
            return { cloneOf: (original: Node) => copies.get(original) };
        },
    };
}

/**
 * A masked deep copy of `root`, made with the same hooks and the same copy
 * contract as the capture library (children in order, comments, scripts and
 * styles skipped). The live tree is not touched.
 */
export function maskTree<T extends Element>(root: T, options: { measure?: MeasureFn } = {}): T {
    const mask = createCaptureMask(root, options);
    const copyDeep = (node: Node): Node => {
        const copy = node.cloneNode(false);
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === COMMENT_NODE) continue;
            if (isElement(child) && (child.localName === 'script' || child.localName === 'style')) continue;
            if (!mask.filter(child)) continue;
            copy.appendChild(copyDeep(child));
        }
        if (node.nodeType !== TEXT_NODE) mask.onCloneEachNode(copy);
        return copy;
    };
    const copy = copyDeep(root);
    mask.apply(copy);
    return copy as T;
}
