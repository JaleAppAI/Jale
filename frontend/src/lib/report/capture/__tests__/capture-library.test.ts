// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasMock, type CanvasMock } from './canvas-mock';

/*
 * captureViewport with the REAL capture library. jsdom cannot rasterise an
 * SVG, so only the last step is intercepted: the library builds its SVG copy
 * of the page with the capture's real options and hooks, and the test reads
 * that SVG instead of drawing it. Every network request the library makes is
 * recorded.
 */

const state = vi.hoisted(() => ({
    events: [] as string[],
    svg: [] as string[],
}));

vi.mock('modern-screenshot', async (importOriginal) => {
    const real = await importOriginal<typeof import('modern-screenshot')>();
    return {
        ...real,
        createContext: (node: Node, options: Parameters<typeof real.createContext>[1] = {}) =>
            real.createContext(node, {
                ...options,
                onCloneNode: async (copy: Node) => {
                    state.events.push('onCloneNode');
                    await options.onCloneNode?.(copy);
                },
            }),
        domToCanvas: async (context: Awaited<ReturnType<typeof real.createContext>>) => {
            const svg = await real.domToForeignObjectSvg(context);
            state.svg.push(new XMLSerializer().serializeToString(svg));
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(context.width * context.scale);
            canvas.height = Math.floor(context.height * context.scale);
            return canvas;
        },
    };
});

const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

let canvas: CanvasMock;
let fetchSpy: ReturnType<typeof vi.fn>;
const realGetComputedStyle = window.getComputedStyle.bind(window);

beforeEach(() => {
    canvas = installCanvasMock();
    state.events = [];
    state.svg = [];
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        state.events.push(`fetch ${String(input)}`);
        return new Response(new Blob([PNG_1PX], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    // jsdom does not compute pseudo-element styles and says so on every call.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => realGetComputedStyle(el));

    document.body.innerHTML = `
      <header><img id="logo" data-capture-safe src="https://app.example.invalid/brand/logo.png" alt="Brand"><h1>Fake employer screen</h1></header>
      <main>
        <p>Copy that stays visible</p>
        <dl><dt>Phone</dt><dd data-private>(555) 010-0177</dd><dt>Email</dt><dd data-private>someone@example.invalid</dd></dl>
        <input id="field" value="typed fake secret">
        <img id="upload" src="https://uploads.example.invalid/photo-of-a-document.jpg" alt="">
        <div style="background-image: url(https://uploads.example.invalid/background-photo.jpg)">on a photo</div>
        <ul><li data-private>Fake reference answer</li></ul>
      </main>
      <div data-capture-exclude role="dialog"><p>Report sheet fake text</p><img src="https://uploads.example.invalid/in-the-sheet.jpg" alt=""></div>`;
    // An image that never finishes loading must not hold the capture up.
    Object.defineProperty(document.getElementById('upload')!, 'complete', { value: false, configurable: true });
});

afterEach(() => {
    canvas.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('captureViewport with the real library', () => {
    it('hides every private value, form value, uploaded image and excluded area before drawing', async () => {
        const { captureViewport } = await import('../index');
        const result = await captureViewport({ timeoutMs: 2000 });
        expect(result).toMatchObject({ ok: true });
        expect(state.svg).toHaveLength(1);
        const svg = state.svg[0];
        expect(svg).toContain('Copy that stays visible');
        for (const secret of [
            '010-0177',
            'someone@example.invalid',
            'typed fake secret',
            'Fake reference answer',
            'uploads.example.invalid',
            'Report sheet fake text',
        ]) {
            expect(svg, `"${secret}" reached the drawing`).not.toContain(secret);
        }
        expect(svg).toContain('data-capture-masked="private"');
        expect(svg).toContain('data-capture-masked="field"');
        expect(svg).toContain('data-capture-masked="media"');
    }, 10_000);

    it('never fetches a masked image, and fetches anything only after the masking ran', async () => {
        const { captureViewport } = await import('../index');
        await captureViewport({ timeoutMs: 2000 });
        const fetched = fetchSpy.mock.calls.map(([url]) => String(url));
        expect(fetched.some((url) => url.includes('uploads.example.invalid'))).toBe(false);
        // The brand logo is the one image embedded.
        expect(fetched).toEqual(['https://app.example.invalid/brand/logo.png']);
        const maskedAt = state.events.indexOf('onCloneNode');
        expect(maskedAt).toBeGreaterThanOrEqual(0);
        expect(state.events.findIndex((e) => e.startsWith('fetch '))).toBeGreaterThan(maskedAt);
    }, 10_000);

    it('does not wait for images that never finish loading', async () => {
        const { captureViewport } = await import('../index');
        const started = Date.now();
        const result = await captureViewport({ timeoutMs: 2500 });
        expect(result.ok).toBe(true);
        expect(Date.now() - started).toBeLessThan(2000);
    }, 10_000);

    it('draws no image from a pseudo-element of a kept element, an embedded one included', async () => {
        // jsdom computes no pseudo-element styles, so this element's ::after is
        // given one: an image as a data URL, the kind the library would carry
        // into its style sheet untouched.
        document.body.insertAdjacentHTML('beforeend', '<p id="decorated">Decorated copy</p>');
        const declared: Record<string, string> = {
            content: '""',
            display: 'block',
            'background-image': 'url("data:image/gif;base64,RkFLRS1QU0VVRE8=")',
        };
        const names = Object.keys(declared);
        const pseudoStyle = {
            length: names.length,
            item: (i: number) => names[i],
            getPropertyValue: (name: string) => declared[name] ?? '',
            getPropertyPriority: () => '',
        } as unknown as CSSStyleDeclaration;
        vi.mocked(window.getComputedStyle).mockImplementation((el: Element, pseudo?: string | null) =>
            pseudo === '::after' && el.id === 'decorated' ? pseudoStyle : realGetComputedStyle(el));

        const { captureViewport } = await import('../index');
        const result = await captureViewport({ timeoutMs: 2000 });
        expect(result).toMatchObject({ ok: true });
        const svg = state.svg[0];
        expect(svg).toContain('Decorated copy');
        // The pseudo-element was copied, and its image was not.
        expect(svg).toMatch(/::after/);
        expect(svg).not.toContain('RkFLRS1QU0VVRE8=');
    }, 10_000);

    it('removes the library sandbox from the page afterwards', async () => {
        const { captureViewport } = await import('../index');
        await captureViewport({ timeoutMs: 2000 });
        expect(document.querySelector('iframe[id^="__SANDBOX__"]')).toBeNull();
    }, 10_000);
});
