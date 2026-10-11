// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
    MASK_FILL,
    classifyNode,
    createCaptureMask,
    maskTree,
    measureElement,
    scrubStyleSheets,
    type MaskBox,
} from '../mask';

/*
 * The fixture is a small page with every kind of thing the capture must hide:
 * marked private fields, form values, uploaded images, an inline background
 * photo, an excluded sheet -- next to things it must keep: a brand logo, a
 * gradient, ordinary copy. All values are obviously fake.
 */
const FIXTURE = `
  <header>
    <img id="logo" data-capture-safe src="/brand/test-logo.png" alt="Brand">
    <h1>Applicant detail</h1>
  </header>
  <main>
    <p>Visible copy that stays.</p>
    <dl>
      <dt>Phone</dt><dd id="phone" data-private>(555) 010-0199</dd>
      <dt>Email</dt><dd id="email" data-private><a href="mailto:person@example.invalid">person@example.invalid</a></dd>
      <dt>Birth</dt><dd id="dob" data-private title="1990-01-01">Jan 1, 1990</dd>
    </dl>
    <table><tbody><tr><th>Pay</th><td id="pay" data-private>Fake pay answer 99</td></tr></tbody></table>
    <span id="addr" data-private>123 Example Street</span>
    <p id="hidden-private" data-private style="display:none">Hidden fake secret</p>
    <form>
      <input id="in-text" value="typed-fake-value">
      <input id="in-check" type="checkbox" checked>
      <textarea id="ta">fake textarea words</textarea>
      <select id="sel"><option>Fake option A</option><option selected>Fake option B</option></select>
      <div id="ce" contenteditable="true">editable fake words</div>
    </form>
    <img id="upload" src="https://uploads.example.invalid/fake-photo.jpg" alt="upload">
    <picture id="pic"><source srcset="https://uploads.example.invalid/p.webp"><img src="https://uploads.example.invalid/p.jpg" alt=""></picture>
    <video id="vid" src="https://uploads.example.invalid/v.mp4"></video>
    <canvas id="cv"></canvas>
    <iframe id="frame" data-capture-safe src="https://frames.example.invalid/"></iframe>
    <object id="obj" data="https://frames.example.invalid/o.pdf"></object>
    <embed id="emb" src="https://frames.example.invalid/e.pdf">
    <svg id="svg-icon" width="10" height="10"><path d="M0 0h10v10z"></path><image id="svg-img" href="https://uploads.example.invalid/s.png" x="1" y="2" width="3" height="4"></image></svg>
    <div id="bg-photo" style="background-image: url(https://uploads.example.invalid/bg.jpg)">over a photo</div>
    <div id="bg-grad" style="background-image: linear-gradient(red, blue)">gradient</div>
    <div id="bg-safe" data-capture-safe style="background-image: url(/brand/pattern.png)">brand pattern</div>
    <div data-capture-safe><img id="safe-child" src="/brand/icon.png" alt=""></div>
    <noscript><p>noscript fake text</p></noscript>
  </main>
  <div id="sheet" data-capture-exclude><p>Report sheet fake words</p><input value="sheet-fake-input"></div>
`;

const PRIVATE_STRINGS = [
    '010-0199',
    'person@example.invalid',
    'mailto:',
    '1990-01-01',
    'Jan 1, 1990',
    'Fake pay answer 99',
    '123 Example Street',
    'Hidden fake secret',
    'typed-fake-value',
    'fake textarea words',
    'Fake option',
    'editable fake words',
    'fake-photo.jpg',
    'uploads.example.invalid',
    'frames.example.invalid',
    'Report sheet fake words',
    'sheet-fake-input',
    'noscript fake text',
];

/** Sizes keyed by id; jsdom has no layout, so the test supplies the boxes. */
const SIZES: Record<string, [number, number]> = {
    phone: [140, 20],
    email: [220, 20],
    dob: [90, 20],
    pay: [130, 30],
    addr: [150, 18],
    'in-text': [200, 44],
    'in-check': [20, 20],
    ta: [300, 96],
    sel: [180, 44],
    ce: [300, 60],
    upload: [320, 240],
    pic: [100, 100],
    vid: [640, 360],
    cv: [300, 150],
    frame: [400, 300],
    obj: [200, 200],
    emb: [200, 200],
};

function fakeMeasure(el: Element): MaskBox {
    if (el.id === 'hidden-private') return { rendered: false, width: 0, height: 0, display: 'none', style: {} };
    if (el.id === 'svg-img') return { rendered: true, width: 3, height: 4, display: 'inline', style: {}, svg: { x: 1, y: 2, width: 3, height: 4, transform: null } };
    const [width, height] = SIZES[el.id] ?? [10, 10];
    const display = el.localName === 'span' || el.localName === 'img' || el.localName === 'input' ? 'inline-block' : el.localName === 'td' ? 'table-cell' : 'block';
    return { rendered: true, width, height, display, style: { 'margin-top': '4px', position: 'static' } };
}

function mount(): HTMLElement {
    document.body.innerHTML = FIXTURE;
    return document.body;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('classifyNode', () => {
    it('sorts every kind of element the masking cares about', () => {
        mount();
        const byId = (id: string) => document.getElementById(id)!;
        expect(classifyNode(byId('sheet'))).toBe('exclude');
        expect(classifyNode(byId('phone'))).toBe('private');
        expect(classifyNode(byId('in-text'))).toBe('field');
        expect(classifyNode(byId('ta'))).toBe('field');
        expect(classifyNode(byId('sel'))).toBe('field');
        expect(classifyNode(byId('ce'))).toBe('field');
        expect(classifyNode(byId('upload'))).toBe('media');
        expect(classifyNode(byId('pic'))).toBe('media');
        expect(classifyNode(byId('vid'))).toBe('media');
        expect(classifyNode(byId('cv'))).toBe('media');
        expect(classifyNode(byId('svg-img'))).toBe('media');
        expect(classifyNode(byId('logo'))).toBe('keep');
        expect(classifyNode(byId('safe-child'))).toBe('keep');
        expect(classifyNode(byId('svg-icon'))).toBe('keep');
        expect(classifyNode(document.body.querySelector('noscript')!)).toBe('exclude');
        expect(classifyNode(document.createTextNode('x'))).toBe('keep');
    });

    it('never lets the capture-safe mark keep a frame or an embedded object', () => {
        mount();
        expect(classifyNode(document.getElementById('frame')!)).toBe('media');
        expect(classifyNode(document.getElementById('obj')!)).toBe('media');
        expect(classifyNode(document.getElementById('emb')!)).toBe('media');
    });

    it('keeps private marks even inside a capture-safe area', () => {
        document.body.innerHTML = '<div data-capture-safe><span id="p" data-private>fake</span></div>';
        expect(classifyNode(document.getElementById('p')!)).toBe('private');
    });
});

describe('maskTree', () => {
    it('leaves no private text, value or uploaded media in the clone', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        const html = clone.outerHTML;
        for (const secret of PRIVATE_STRINGS) {
            expect(html, `"${secret}" survived`).not.toContain(secret);
        }
        expect(clone.querySelectorAll('input, textarea, select, video, canvas, iframe, object, embed, picture, [contenteditable]')).toHaveLength(0);
    });

    it('keeps the page around the masks', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        expect(clone.textContent).toContain('Visible copy that stays.');
        expect(clone.textContent).toContain('Applicant detail');
        const logo = clone.querySelector('img#logo') as HTMLImageElement | null;
        expect(logo?.getAttribute('src')).toBe('/brand/test-logo.png');
        expect(clone.querySelector('img#safe-child')?.getAttribute('src')).toBe('/brand/icon.png');
        expect(clone.querySelector('#svg-icon path')).not.toBeNull();
    });

    it('does not touch the live page', () => {
        const root = mount();
        const before = root.innerHTML;
        maskTree(root, { measure: fakeMeasure });
        expect(root.innerHTML).toBe(before);
    });

    it('replaces each masked element by a solid box of its measured size, in place', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        const boxes = Array.from(clone.querySelectorAll<HTMLElement>('[data-capture-masked]'));
        // phone, email, dob, pay, addr; 5 fields; upload, pic, vid, cv, frame, obj, emb (svg image is a rect)
        expect(boxes.filter((b) => b.dataset.captureMasked === 'private')).toHaveLength(5);
        expect(boxes.filter((b) => b.dataset.captureMasked === 'field')).toHaveLength(5);
        expect(boxes.filter((b) => b.dataset.captureMasked === 'media')).toHaveLength(8);

        const dd = clone.querySelectorAll('dd');
        expect(dd).toHaveLength(3);
        expect(dd[0].dataset.captureMasked).toBe('private');
        expect(dd[0].style.width).toBe('140px');
        expect(dd[0].style.height).toBe('20px');
        expect(dd[0].style.backgroundColor).not.toBe('');
        expect(dd[0].childNodes).toHaveLength(0);
        // The previous sibling is still the label, so the box sits where the value was.
        expect(dd[0].previousElementSibling?.textContent).toBe('Phone');

        const td = clone.querySelector('td');
        expect(td?.dataset.captureMasked).toBe('private');
        expect(td?.style.width).toBe('130px');
        expect(td?.style.height).toBe('30px');

        const addr = boxes.find((b) => b.style.width === '150px')!;
        expect(addr.style.display).toBe('inline-block');
        expect(addr.style.marginTop).toBe('4px');
        expect(addr.style.boxSizing).toBe('border-box');

        const field = boxes.find((b) => b.style.width === '300px' && b.style.height === '96px');
        expect(field?.dataset.captureMasked).toBe('field');
        const upload = boxes.find((b) => b.style.width === '320px' && b.style.height === '240px');
        expect(upload?.dataset.captureMasked).toBe('media');
    });

    it('carries no attribute of the masked element into its box', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        for (const box of Array.from(clone.querySelectorAll('[data-capture-masked]'))) {
            const names = box.getAttributeNames().sort();
            expect(names.every((n) => ['data-capture-masked', 'style', 'x', 'y', 'width', 'height', 'fill', 'transform'].includes(n)), names.join(',')).toBe(true);
        }
    });

    it('paints a grey SVG rect over an image inside an SVG', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        const svg = clone.querySelector('#svg-icon')!;
        const rect = svg.querySelector('rect[data-capture-masked]');
        expect(rect).not.toBeNull();
        expect(rect?.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect([rect?.getAttribute('x'), rect?.getAttribute('y'), rect?.getAttribute('width'), rect?.getAttribute('height')]).toEqual(['1', '2', '3', '4']);
        expect(rect?.getAttribute('fill')).toBe(MASK_FILL);
        expect(svg.querySelector('image')).toBeNull();
    });

    it('drops excluded and unrendered elements without leaving a box', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        expect(clone.querySelector('#sheet')).toBeNull();
        expect(clone.querySelector('noscript')).toBeNull();
        // The hidden private paragraph leaves nothing behind.
        expect(clone.querySelectorAll('p[data-capture-masked]')).toHaveLength(0);
    });

    it('replaces a background photo by the grey fill, and keeps gradients and brand backgrounds', () => {
        const root = mount();
        const clone = maskTree(root, { measure: fakeMeasure });
        const photo = clone.querySelector<HTMLElement>('#bg-photo')!;
        expect(photo.style.backgroundImage).toBe('none');
        expect(photo.style.backgroundColor).not.toBe('');
        expect(photo.textContent).toBe('over a photo');
        expect(clone.querySelector<HTMLElement>('#bg-grad')!.style.backgroundImage).toContain('linear-gradient');
        expect(clone.querySelector<HTMLElement>('#bg-safe')!.style.backgroundImage).toContain('/brand/pattern.png');
    });
});

describe('createCaptureMask (the hooks a capture library calls)', () => {
    it('refuses a masked node before it is cloned, and puts its box back afterwards', () => {
        const root = mount();
        const mask = createCaptureMask(root, { measure: fakeMeasure });
        expect(mask.filter(document.getElementById('upload')!)).toBe(false);
        expect(mask.filter(document.getElementById('phone')!)).toBe(false);
        expect(mask.filter(document.getElementById('sheet')!)).toBe(false);
    });

    it('fails closed when the clone order does not match what it was shown', async () => {
        const root = mount();
        const mask = createCaptureMask(root, { measure: fakeMeasure });
        const main = root.querySelector('main')!;
        expect(mask.filter(main)).toBe(true);
        // The library reports a clone of a different element than the one accepted.
        await expect(Promise.resolve().then(() => mask.onCloneEachNode(document.createElement('section')))).rejects.toThrow(/capture_mask/);
    });

    it('fails closed when apply runs before every accepted node was reported', () => {
        const root = mount();
        const mask = createCaptureMask(root, { measure: fakeMeasure });
        mask.filter(root.querySelector('main')!);
        expect(() => mask.apply(root.cloneNode(false))).toThrow(/capture_mask/);
    });
});

describe('measureElement', () => {
    it('reports an unrendered element as such', () => {
        document.body.innerHTML = '<span id="x" style="display:none">x</span>';
        expect(measureElement(document.getElementById('x')!).rendered).toBe(false);
    });

    it('turns an inline box into an inline-block one of the same size', () => {
        document.body.innerHTML = '<span id="x">x</span>';
        const el = document.getElementById('x')!;
        Object.defineProperty(el, 'offsetWidth', { value: 42 });
        Object.defineProperty(el, 'offsetHeight', { value: 17 });
        const box = measureElement(el);
        expect(box).toMatchObject({ rendered: true, width: 42, height: 17, display: 'inline-block' });
    });
});

describe('measureElement alignment', () => {
    it('hangs a text box from the text bottom, and leaves an image on the baseline', () => {
        document.body.innerHTML = '<p>Phone: <span id="t" style="vertical-align: baseline">x</span> <img id="i" style="vertical-align: baseline" alt=""></p>';
        expect(measureElement(document.getElementById('t')!).style['vertical-align']).toBe('text-bottom');
        expect(measureElement(document.getElementById('i')!).style['vertical-align']).toBe('baseline');
    });
});

describe('scrubStyleSheets', () => {
    /** The copy's style sheet as the capture library writes it, scrubbed. */
    function scrubbed(css: string): string {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const style = document.createElement('style');
        style.textContent = css;
        svg.appendChild(style);
        scrubStyleSheets(svg);
        return style.textContent ?? '';
    }

    // The fixed rule the library always writes first, and an embedded font in
    // the shape it appends after the pseudo-element rules.
    const LIBRARY_RULE = '.______background-clip--text {\n  background-clip: text;\n  -webkit-background-clip: text;\n}';
    const FONT = '@font-face { font-family: "Fake Sans"; src: url(data:font/woff2;base64,RkFLRUZPTlQ=) format("woff2"); font-display: swap; }';

    it('removes every image address that was not embedded', () => {
        const text = scrubbed([
            '.a::before { content: ""; background-image: url("https://uploads.example.invalid/x.jpg"); }',
            ".b::after { background-image: url('/relative/y.png'), linear-gradient(red, blue); }",
            '.c::after { background-image: url(https://uploads.example.invalid/z.jpg); }',
        ].join('\n'));
        expect(text).not.toContain('uploads.example.invalid');
        expect(text).not.toContain('/relative/y.png');
    });

    it('removes embedded images from pseudo-element rules too, and keeps the embedded fonts', () => {
        const text = scrubbed([
            LIBRARY_RULE,
            '.d::after { content: ""; background-image: url("data:image/png;base64,QUFBQQ=="); }',
            FONT,
        ].join('\n'));
        expect(text).not.toContain('data:image/png');
        expect(text).toContain(FONT);
        expect(text).toContain(LIBRARY_RULE);
        expect(text).toMatch(/\.d::after \{ content: ""; background-image: none; \}/);
    });

    it.each([
        ['border-image-source', 'url("data:image/png;base64,QkJCQg==")'],
        ['-webkit-border-image', 'url(data:image/png;base64,QkJCQg==) 30 round'],
        ['list-style-image', 'url(data:image/png;base64,QkJCQg==)'],
        ['mask-image', 'url("data:image/svg+xml;base64,QkJCQg==")'],
        ['-webkit-mask-image', 'url(data:image/svg+xml;base64,QkJCQg==)'],
        ['background-image', 'image-set(url(data:image/png;base64,QkJCQg==) 1x)'],
        ['background-image', 'linear-gradient(red, blue), url(data:image/png;base64,QkJCQg==)'],
    ])('sets %s to none in a pseudo-element rule when it draws an embedded image (%s)', (property, value) => {
        const text = scrubbed(`.e::before {\n  content: '';\n  ${property}: ${value};\n  color: red;\n}`);
        expect(text).not.toContain('QkJCQg==');
        expect(text).toContain(`${property}: none;`);
        expect(text).toContain('color: red;');
    });

    it('empties pseudo-element content that names an image, and keeps plain text content', () => {
        const text = scrubbed([
            ".f::after {\n  content: 'url(data:image/png;base64,Q0NDQw==)';\n}",
            ".g::after {\n  content: 'Fake label';\n}",
        ].join('\n'));
        expect(text).not.toContain('Q0NDQw==');
        expect(text).toContain(".f::after {\n  content: '';\n}");
        expect(text).toContain("content: 'Fake label';");
    });

    it('keeps gradients, and keeps a declaration important', () => {
        const text = scrubbed([
            '.h::before { background-image: linear-gradient(red, blue); }',
            '.i::before { background-image: url(data:image/png;base64,RERERA==) !important; }',
        ].join('\n'));
        expect(text).toContain('background-image: linear-gradient(red, blue);');
        expect(text).toContain('background-image: none !important;');
        expect(text).not.toContain('RERERA==');
    });

    it.each([
        ['an opening brace', '"{"'],
        ['a closing brace', "'}'"],
    ])('removes the embedded image of a rule whose content is %s in quotes, and keeps the fonts', (_shape, content) => {
        const text = scrubbed([
            LIBRARY_RULE,
            `.k::after { content: ${content}; background-image: url("data:image/png;base64,RkZGRg=="); }`,
            FONT,
        ].join('\n'));
        expect(text).not.toContain('RkZGRg==');
        expect(text).toContain(`content: ${content};`);
        expect(text).toContain('background-image: none;');
        expect(text).toContain(FONT);
        expect(text).toContain(LIBRARY_RULE);
    });

    it('removes the images a rule declares next to a rule nested in it, and those an at-rule declares directly', () => {
        const text = scrubbed([
            '.l::after { background-image: url("data:image/png;base64,R0dHRw=="); & .m { color: red; list-style-image: url(data:image/png;base64,SEhISA==); } }',
            '@page { margin: 0; background-image: url(data:image/png;base64,SUlJSQ==); }',
            FONT,
        ].join('\n'));
        expect(text).not.toContain('R0dHRw==');
        expect(text).not.toContain('SEhISA==');
        expect(text).not.toContain('SUlJSQ==');
        expect(text).toContain('color: red;');
        expect(text).toContain('margin: 0;');
        expect(text).toContain(FONT);
    });

    it('reaches rules nested in a block and leaves semicolons inside strings alone', () => {
        const text = scrubbed([
            '@media (min-width: 1px) { .j::after { content: "a;b"; background-image: url("data:image/png;base64,RUVFRQ=="); } }',
            FONT,
        ].join('\n'));
        expect(text).not.toContain('RUVFRQ==');
        expect(text).toContain('content: "a;b";');
        expect(text).toContain(FONT);
    });

    it('keeps the condition of an at-rule nested in a block whole, and removes the images its rules declare', () => {
        const condition = '@supports (background-image: url("data:image/png;base64,SkpKSg=="))';
        const text = scrubbed([
            `@media (min-width: 1px) { ${condition} { .n::after { content: "Retry"; background-image: url("data:image/png;base64,S0tLSw=="); } } }`,
            FONT,
        ].join('\n'));
        expect(text).toContain(`${condition} {`);
        expect(text).toContain('content: "Retry";');
        expect(text).not.toContain('S0tLSw==');
        expect(text).toContain('background-image: none;');
        expect(text).toContain(FONT);
    });
});
