// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installCanvasMock, type CanvasMock } from './canvas-mock';

/*
 * captureViewport against a stand-in for the capture library. The stand-in
 * copies the page the way the library does (children in order, `filter`
 * before each copy, `onCloneEachNode` after it, `onCloneNode` once at the
 * end), so the hooks the capture passes are exercised for real. A separate
 * suite runs the real library (capture-library.test.ts).
 */

type Hooks = {
    filter: (node: Node) => boolean;
    onCloneEachNode: (copy: Node) => void | Promise<void>;
    onCloneNode: (copy: Node) => void | Promise<void>;
};
type FakeContext = Hooks & Record<string, unknown> & { node: Node };

const lib = vi.hoisted(() => ({
    loaded: 0,
    contexts: [] as Array<Record<string, unknown>>,
    copies: [] as Node[],
    destroyed: 0,
    domToCanvas: null as null | ((ctx: FakeContext) => Promise<HTMLCanvasElement>),
    createContext: null as null | ((node: Node, options: Record<string, unknown>) => Promise<FakeContext>),
}));

vi.mock('modern-screenshot', () => {
    lib.loaded += 1;
    return {
        createContext: (node: Node, options: Record<string, unknown>) => lib.createContext!(node, options),
        domToCanvas: (ctx: FakeContext) => lib.domToCanvas!(ctx),
        destroyContext: () => {
            lib.destroyed += 1;
        },
    };
});

async function copyLikeTheLibrary(node: Node, ctx: Hooks, isRoot = true): Promise<Node> {
    const copy = node.cloneNode(false);
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 8) continue;
        if (child.nodeType === 1 && ['SCRIPT', 'STYLE'].includes((child as Element).tagName)) continue;
        if (!ctx.filter(child)) continue;
        copy.appendChild(await copyLikeTheLibrary(child, ctx, false));
    }
    if (copy.nodeType !== 3) await ctx.onCloneEachNode(copy);
    if (isRoot) await ctx.onCloneNode(copy);
    return copy;
}

function defaultLibrary() {
    lib.createContext = async (node, options) => ({ ...options, node }) as FakeContext;
    lib.domToCanvas = async (ctx) => {
        lib.contexts.push(ctx);
        lib.copies.push(await copyLikeTheLibrary(ctx.node, ctx));
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor((ctx.width as number) * (ctx.scale as number));
        canvas.height = Math.floor((ctx.height as number) * (ctx.scale as number));
        return canvas;
    };
}

let canvas: CanvasMock;

beforeEach(() => {
    canvas = installCanvasMock();
    lib.contexts = [];
    lib.copies = [];
    lib.destroyed = 0;
    defaultLibrary();
    document.body.innerHTML = `
      <header id="bar" style="position: sticky; top: 0px">Bar</header>
      <main>
        <p>Visible copy</p>
        <span id="phone" data-private>(555) 010-0142</span>
        <div id="list" style="overflow: auto"><div id="row1">row one</div><div id="row2">row two</div></div>
      </main>
      <div id="sheet" data-capture-exclude><p>Sheet fake words</p></div>`;
});

afterEach(() => {
    canvas.restore();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

async function load() {
    return import('../index');
}

describe('captureViewport', () => {
    it('does not load the capture library until a capture is asked for', async () => {
        const { captureViewport } = await load();
        expect(lib.loaded).toBe(0);
        await captureViewport();
        expect(lib.loaded).toBe(1);
    });

    it('imports the library only through a dynamic import', () => {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;
        for (const file of ['index.ts', 'mask.ts', 'encode.ts']) {
            const text = readFileSync(dir + file, 'utf8');
            expect(text, file).not.toMatch(/from\s+['"]modern-screenshot['"]/);
        }
        expect(readFileSync(dir + 'index.ts', 'utf8')).toMatch(/import\(\s*['"]modern-screenshot['"]\s*\)/);
    });

    it('returns a JPEG at quality 0.8 of the visible viewport', async () => {
        const { captureViewport } = await load();
        const result = await captureViewport();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(canvas.toBlobCalls).toHaveLength(1);
        expect(canvas.toBlobCalls[0]).toMatchObject({ type: 'image/jpeg', quality: 0.8 });
        expect(result.image).toBe(canvas.toBlobCalls[0].blob);
        expect(result.width).toBe(canvas.toBlobCalls[0].canvas.width);
        expect(result.height).toBe(canvas.toBlobCalls[0].canvas.height);
        expect(result.ms).toBeGreaterThanOrEqual(0);
        const ctx = lib.contexts[0];
        expect(ctx.width).toBe(window.innerWidth);
        expect(ctx.height).toBe(window.innerHeight);
        expect(Math.max(ctx.width as number, ctx.height as number) * (ctx.scale as number)).toBeLessThanOrEqual(1600);
    });

    it('passes the masking hooks and copies the whole document', async () => {
        const { captureViewport } = await load();
        await captureViewport();
        const ctx = lib.contexts[0];
        expect(typeof ctx.filter).toBe('function');
        expect(typeof ctx.onCloneEachNode).toBe('function');
        expect(typeof ctx.onCloneNode).toBe('function');
        expect(ctx.node).toBe(document.documentElement);
        expect(lib.destroyed).toBe(1);
        const copy = lib.copies[0] as HTMLElement;
        expect(copy.textContent).toContain('Visible copy');
        expect(copy.textContent).not.toContain('010-0142');
        expect(copy.textContent).not.toContain('Sheet fake words');
        expect(copy.querySelector('[data-capture-masked="private"]')).not.toBeNull();
    });

    it('creates the library context without asking it to wait for the page images', async () => {
        const { captureViewport } = await load();
        let contextNode: Node | null = null;
        lib.createContext = async (node, options) => {
            contextNode = node;
            return { ...options, node } as FakeContext;
        };
        await captureViewport();
        // A bare element with no images: the library's image wait has nothing to wait for.
        expect(contextNode).not.toBe(document.documentElement);
        expect((contextNode as unknown as Element).querySelectorAll('img')).toHaveLength(0);
        expect(lib.contexts[0].node).toBe(document.documentElement);
    });

    it('places the copy at the current scroll position, with stuck headers where they are seen', async () => {
        const { captureViewport } = await load();
        Object.defineProperty(window, 'scrollY', { value: 300, configurable: true });
        Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
        const bar = document.getElementById('bar')!;
        const styleBefore = bar.getAttribute('style');
        // Stuck at the top of the screen; its place in the page flow is 300px higher.
        bar.getBoundingClientRect = () =>
            ({ top: bar.style.position === 'static' ? -300 : 0, left: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0 }) as DOMRect;
        const list = document.getElementById('list')!;
        Object.defineProperty(list, 'scrollTop', { value: 25, configurable: true });

        try {
            await captureViewport();
        } finally {
            Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
        }
        // The live page is left exactly as it was.
        expect(bar.getAttribute('style')).toBe(styleBefore);

        const copy = lib.copies[0] as HTMLElement;
        expect(copy.style.marginTop).toBe('-300px');
        expect(copy.style.position).toBe('relative');
        const barCopy = copy.querySelector<HTMLElement>('#bar')!;
        expect(barCopy.style.position).toBe('relative');
        expect(barCopy.style.top).toBe('300px');
        const row = copy.querySelector<HTMLElement>('#row1')!;
        expect(row.style.transform).toContain('translate(0px, -25px)');
    });

    it('reports a timeout when the drawing takes longer than allowed, and never throws', async () => {
        const { captureViewport } = await load();
        lib.domToCanvas = () => new Promise(() => {});
        const result = await captureViewport({ timeoutMs: 40 });
        expect(result).toMatchObject({ ok: false, reason: 'timeout' });
        expect(result.ms).toBeGreaterThanOrEqual(30);
    });

    it('times out at 3 seconds by default', async () => {
        vi.useFakeTimers();
        const { captureViewport } = await load();
        lib.domToCanvas = () => new Promise(() => {});
        let settled: unknown = null;
        void captureViewport().then((r) => {
            settled = r;
        });
        await vi.advanceTimersByTimeAsync(2990);
        expect(settled).toBeNull();
        await vi.advanceTimersByTimeAsync(20);
        expect(settled).toMatchObject({ ok: false, reason: 'timeout' });
    });

    it('reports a failure when the library throws', async () => {
        const { captureViewport } = await load();
        lib.domToCanvas = async () => {
            throw new Error('boom');
        };
        await expect(captureViewport()).resolves.toMatchObject({ ok: false, reason: 'failed' });
        expect(lib.destroyed).toBe(1);
    });

    it('reports a failure when the copy arrives in an order the mask did not see', async () => {
        const { captureViewport } = await load();
        lib.domToCanvas = async (ctx) => {
            ctx.filter(document.body);
            await ctx.onCloneEachNode(document.createElement('aside'));
            return document.createElement('canvas');
        };
        await expect(captureViewport()).resolves.toMatchObject({ ok: false, reason: 'failed' });
    });

    it('reports a failure when the encode fails', async () => {
        const { captureViewport } = await load();
        canvas.nextBlob = () => null;
        await expect(captureViewport()).resolves.toMatchObject({ ok: false, reason: 'failed' });
    });

    it('reports unsupported when the browser has no 2D canvas', async () => {
        const { captureViewport } = await load();
        canvas.restore();
        const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        try {
            await expect(captureViewport()).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
        } finally {
            spy.mockRestore();
            canvas = installCanvasMock();
        }
    });
});

describe('captureViewport when the library cannot load', () => {
    it('reports unsupported', async () => {
        vi.resetModules();
        vi.doMock('modern-screenshot', () => {
            throw new Error('chunk load failed');
        });
        try {
            const { captureViewport } = await import('../index');
            await expect(captureViewport()).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
        } finally {
            vi.doUnmock('modern-screenshot');
            vi.resetModules();
        }
    });
});
