// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The phone tab bar and what sits on it meet at ONE edge.
 *
 * Its nominal height is a token (`--jale-tab-bar-height`, the tabs plus the
 * top rule) and the bar never renders shorter than that plus the safe-area
 * inset. A label that wraps (a long Spanish tab, or the phone's text size
 * turned up) makes it taller, so the bar also measures itself and writes the
 * real height to `--jale-tab-bar-offset` on <html>. The shell's bottom
 * padding and the job page's Apply bar read that one value, so they meet the
 * bar exactly whatever its height.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import { BottomTabBar } from '../BottomTabBar';

const OFFSET = '--jale-tab-bar-offset';
const offset = () => document.documentElement.style.getPropertyValue(OFFSET);

/** A stand-in ResizeObserver: records what it watches and lets a test report sizes. */
class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    readonly targets: Array<{ target: Element; options?: ResizeObserverOptions }> = [];
    disconnected = false;

    constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }

    observe(target: Element, options?: ResizeObserverOptions) {
        this.targets.push({ target, options });
    }

    unobserve() {}

    disconnect() {
        this.disconnected = true;
    }

    /** Reports the watched element at this border-box height. */
    resize(blockSize: number, withBoxSizes = true) {
        const target = this.targets[0].target;
        const entry = {
            target,
            borderBoxSize: withBoxSizes ? [{ blockSize, inlineSize: 390 }] : undefined,
            contentBoxSize: withBoxSizes ? [{ blockSize, inlineSize: 390 }] : undefined,
            contentRect: { height: blockSize, width: 390 },
        } as unknown as ResizeObserverEntry;
        this.callback([entry], this as unknown as ResizeObserver);
    }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

beforeEach(() => {
    FakeResizeObserver.instances = [];
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: FakeResizeObserver,
    });
});

afterEach(() => {
    document.documentElement.style.removeProperty(OFFSET);
    if (original) Object.defineProperty(globalThis, 'ResizeObserver', original);
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const nav = () => document.querySelector('nav')!;
const observer = () => FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];

describe('the phone tab bar measures itself for what sits on it', () => {
    it('watches its own border box, so the safe-area padding and the top rule count', () => {
        renderIntl(<BottomTabBar role="worker" />);
        expect(observer().targets).toEqual([{ target: nav(), options: { box: 'border-box' } }]);
    });

    it('writes its measured height to the shared offset', () => {
        renderIntl(<BottomTabBar role="worker" />);
        observer().resize(64);
        expect(offset()).toBe('64px');
    });

    it('follows a wrapped label up, and back down when it unwraps', () => {
        renderIntl(<BottomTabBar role="employer" />);
        observer().resize(64);
        observer().resize(80.5);
        expect(offset()).toBe('80.5px');
        observer().resize(64);
        expect(offset()).toBe('64px');
    });

    it('reads its height from the element when the browser gives no box sizes', () => {
        renderIntl(<BottomTabBar role="worker" />);
        vi.spyOn(nav(), 'getBoundingClientRect').mockReturnValue({ height: 72 } as DOMRect);
        observer().resize(72, false);
        expect(offset()).toBe('72px');
    });

    it('drops the measured value when the bar is hidden, leaving the nominal one', () => {
        renderIntl(<BottomTabBar role="worker" />);
        observer().resize(64);
        observer().resize(0);
        expect(offset()).toBe('');
    });

    it('drops the measured value and stops watching when it unmounts', () => {
        const { unmount } = renderIntl(<BottomTabBar role="worker" />);
        observer().resize(64);
        unmount();
        expect(offset()).toBe('');
        expect(observer().disconnected).toBe(true);
    });

    it('leaves a value another bar wrote since in place when it unmounts', () => {
        const first = renderIntl(<BottomTabBar role="worker" />);
        const firstObserver = observer();
        firstObserver.resize(64);
        renderIntl(<BottomTabBar role="worker" />);
        observer().resize(70);
        first.unmount();
        expect(offset()).toBe('70px');
    });

    it('renders, and writes nothing, where there is no ResizeObserver', () => {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
        expect(() => renderIntl(<BottomTabBar role="worker" />)).not.toThrow();
        expect(nav()).toBeInTheDocument();
        expect(offset()).toBe('');
    });

    it('is never shorter than the nominal height, and its minimum never reads the measured value', () => {
        renderIntl(<BottomTabBar role="worker" />);
        const classes = nav().className.split(/\s+/);
        // Reading the offset here would let the bar grow and never shrink back.
        expect(classes).toContain('min-h-[calc(var(--jale-tab-bar-height)+env(safe-area-inset-bottom))]');
        expect(nav().className).not.toContain(OFFSET);
        // A minimum, not a height: a wrapped label grows the bar instead of clipping.
        expect(classes.some((c) => /^h-\[/.test(c))).toBe(false);
    });
});

/*
 * The shell reserved a guessed 5rem under every page for the bar. It reads
 * the shared offset now, in both the shell and its loading twin, and the
 * tokens live with the others in `globals.css`.
 */
describe('the shell reserves the bar’s real height', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const read = (file: string) => fs.readFileSync(path.resolve(dir, file), 'utf8');

    it.each(['../AppShell.tsx', '../AppShellSkeleton.tsx'])('%s pads its content by the shared offset', (file) => {
        const source = read(file);
        expect(source).toContain('pb-[var(--jale-tab-bar-offset)] lg:pb-0');
        expect(source).not.toMatch(/5rem/);
    });

    it('defines the nominal height and the offset as tokens', () => {
        const css = read('../../../app/globals.css');
        const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
        expect(root).toMatch(/--jale-tab-bar-height:\s*4rem;/);
        expect(root).toMatch(
            /--jale-tab-bar-offset:\s*calc\(var\(--jale-tab-bar-height\) \+ env\(safe-area-inset-bottom\)\);/,
        );
    });
});
