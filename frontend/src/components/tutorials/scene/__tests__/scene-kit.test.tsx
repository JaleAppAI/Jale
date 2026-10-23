import * as React from 'react';
import { render, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CountUp,
    SCENE_LOOP_MS,
    SCENE_WIDTH,
    SceneAvatar,
    SceneBubble,
    SceneChip,
    SceneClock,
    SceneCycle,
    SceneField,
    SceneFrame,
    SceneLabel,
    SceneNote,
    ScenePointer,
    SceneRow,
    SceneSegments,
    SceneStage,
    SceneToggle,
    SlideIn,
    TapPulse,
    TypeOn,
    stageScale,
} from '..';

/*
 * The scene kit draws the mock screens inside a tutorial slide. Two promises
 * matter more than any pixel:
 *  - the markup alone is the FINAL frame, so reduced motion, a runtime with no
 *    Web Animations API and a still stage all show the finished picture;
 *  - motion is a looping Web Animation layered on top, started only when the
 *    stage is not still and the person has not asked for reduced motion.
 */

function stubReducedMotion(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('prefers-reduced-motion') ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    }));
}

type AnimateCall = {
    element: Element;
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
    cancel: ReturnType<typeof vi.fn>;
};

/**
 * A stand-in for `Element.prototype.animate` that, like a browser, refuses
 * keyframes whose offsets fall outside 0..1 or run backwards.
 */
function stubAnimate() {
    const calls: AnimateCall[] = [];
    const animate = vi.fn(function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        let previous = 0;
        for (const frame of keyframes) {
            if (frame.offset === undefined || frame.offset === null) continue;
            if (frame.offset < 0 || frame.offset > 1 || frame.offset < previous) {
                throw new TypeError('Offsets must be in [0, 1] and non-decreasing');
            }
            previous = frame.offset;
        }
        const cancel = vi.fn();
        calls.push({ element: this, keyframes, options, cancel });
        return { cancel } as unknown as Animation;
    });
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    return { animate, calls };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as { animate?: unknown }).animate;
});

/** One of every piece, the way a slide composes them. */
function EveryPiece() {
    return (
        <>
            <SceneFrame className="w-[260px]">
                <SceneLabel>Job title</SceneLabel>
                <SceneField caret>
                    <TypeOn>Concrete finisher</TypeOn>
                </SceneField>
                <SceneRow trailing="Required" divider>
                    Years of experience
                </SceneRow>
                <SceneChip tone="blue">Concrete</SceneChip>
                <SceneBubble side="end" tone="brand">
                    Can you start Monday at 7?
                </SceneBubble>
                <SceneAvatar initials="TW" tone="teal" />
            </SceneFrame>
            <SlideIn step={2}>
                <span>Popped in</span>
            </SlideIn>
            <TapPulse>
                <SceneChip tone="primary" size="lg">
                    Send
                </SceneChip>
            </TapPulse>
            <TapPulse kind="press">
                <SceneChip tone="primary">Apply</SceneChip>
            </TapPulse>
            <CountUp to={82} />
            <ScenePointer from={{ x: 70, y: 40 }} to={{ x: 266, y: 160 }} />
            <SceneToggle step={1}>Day</SceneToggle>
            <SceneCycle>
                <span>New</span>
                <span>Contacted</span>
                <span>Talking</span>
            </SceneCycle>
            <SceneSegments count={7} tone="teal" thickness="lg" fill="sequence" />
            <SceneClock />
        </>
    );
}

function renderStage(still: boolean, tone: 'blue' | 'teal' = 'blue') {
    return render(
        <SceneStage tone={tone} still={still}>
            <EveryPiece />
        </SceneStage>,
    );
}

describe('stageScale', () => {
    it('keeps the design box at full size when the container is at least as wide', () => {
        expect(stageScale(SCENE_WIDTH)).toBe(1);
        expect(stageScale(640)).toBe(1);
    });

    it('scales the design box down to a narrower container', () => {
        expect(stageScale(248)).toBeCloseTo(248 / SCENE_WIDTH, 3);
        expect(stageScale(159)).toBeCloseTo(0.5, 3);
    });

    it('treats an unmeasured container as full size', () => {
        expect(stageScale(0)).toBe(1);
        expect(stageScale(Number.NaN)).toBe(1);
    });
});

describe('SceneStage', () => {
    it('is hidden from assistive technology and holds nothing focusable', () => {
        const { container } = renderStage(true);
        const stage = container.firstElementChild as HTMLElement;

        expect(stage).toHaveAttribute('aria-hidden', 'true');
        expect(stage.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).toHaveLength(0);
    });

    it('paints the employer stage blue and the worker stage teal', () => {
        const { container, unmount } = renderStage(true, 'blue');
        expect((container.firstElementChild as HTMLElement).className).toContain('var(--jale-blue-50)');
        unmount();

        const worker = renderStage(true, 'teal');
        expect((worker.container.firstElementChild as HTMLElement).className).toContain('var(--jale-teal-50)');
    });

    it('scales the 318 px design box to a narrow container and shrinks its height to match', () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(248);
        const { container } = renderStage(true);
        const stage = container.firstElementChild as HTMLElement;
        const box = stage.firstElementChild as HTMLElement;
        const scale = 248 / SCENE_WIDTH;

        expect(box.style.transform).toContain(`scale(${scale.toFixed(3)})`);
        expect(parseFloat(stage.style.height)).toBeCloseTo(200 * scale, 1);
    });

    it('rescales when the container is resized', () => {
        let width = 318;
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
        const observers: Array<() => void> = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(callback: () => void) {
                    observers.push(callback);
                }
                observe() {}
                disconnect() {}
            },
        );
        const { container } = renderStage(true);
        const stage = container.firstElementChild as HTMLElement;
        expect((stage.firstElementChild as HTMLElement).style.transform).toContain('scale(1)');

        width = 159;
        act(() => observers.forEach((notify) => notify()));

        expect((stage.firstElementChild as HTMLElement).style.transform).toContain('scale(0.500)');
        expect(parseFloat(stage.style.height)).toBeCloseTo(100, 1);
    });
});

describe('still frames', () => {
    it('starts no animation on a still stage', () => {
        stubReducedMotion(false);
        const { animate } = stubAnimate();

        renderStage(true);

        expect(animate).not.toHaveBeenCalled();
    });

    it('starts no animation when the person asks for reduced motion, even on a moving stage', () => {
        stubReducedMotion(true);
        const { animate } = stubAnimate();

        renderStage(false);

        expect(animate).not.toHaveBeenCalled();
    });

    it('draws the final frame: full text, the last cycle state, the final count, no pointer', () => {
        stubAnimate();
        const { container, getByText } = renderStage(true);

        expect(getByText('Concrete finisher')).toBeInTheDocument();
        expect(getByText('82')).toBeInTheDocument();
        expect(container.querySelector('[data-scene-pointer]')).toBeNull();

        const states = ['New', 'Contacted', 'Talking'].map((label) => getByText(label).closest('[data-scene-cycle-item]') as HTMLElement);
        expect(states.map((state) => state.style.opacity)).toEqual(['0', '0', '1']);

        // A toggle's final frame is "on": no "off" layer is drawn over it.
        expect(container.querySelector('[data-scene-toggle-off]')).toBeNull();
    });

    it('renders the finished picture without throwing where there is no Web Animations API', () => {
        stubReducedMotion(false);

        expect(() => renderStage(false)).not.toThrow();
        expect(document.body).toHaveTextContent('Concrete finisher');
    });

    it('does not move outside a stage, so a piece is still by default', () => {
        stubReducedMotion(false);
        const { animate } = stubAnimate();

        render(<EveryPiece />);

        expect(animate).not.toHaveBeenCalled();
    });
});

describe('motion', () => {
    it('plays every animated piece once, on one shared clock, then rests on its final frame', () => {
        stubReducedMotion(false);
        const { calls } = stubAnimate();

        const { container } = renderStage(false);

        const animated = Array.from(container.querySelectorAll('[data-scene-motion]'));
        expect(animated.length).toBeGreaterThanOrEqual(10);
        // Each animated element exactly once, and nothing else.
        expect(calls).toHaveLength(animated.length);
        for (const element of animated) {
            expect(calls.filter((call) => call.element === element)).toHaveLength(1);
        }
        for (const call of calls) {
            expect(call.options.duration).toBe(SCENE_LOOP_MS);
            // Once, then the markup (the final frame) shows: nothing keeps
            // moving beside the slide's text (WCAG 2.2.2).
            expect(call.options.iterations).toBe(1);
        }
    });

    it('draws the pointer only while it moves', () => {
        stubReducedMotion(false);
        stubAnimate();

        const { container } = renderStage(false);

        const pointer = container.querySelector('[data-scene-pointer]');
        expect(pointer).not.toBeNull();
        expect(pointer).toHaveAttribute('aria-hidden', 'true');
    });

    it('cancels every animation when the scene goes away', () => {
        stubReducedMotion(false);
        const { calls } = stubAnimate();

        const { unmount } = renderStage(false);
        unmount();

        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call.cancel).toHaveBeenCalledTimes(1);
    });

    it('stops moving when the stage turns still', () => {
        stubReducedMotion(false);
        const { calls } = stubAnimate();

        const { rerender } = renderStage(false);
        rerender(
            <SceneStage tone="blue" still>
                <EveryPiece />
            </SceneStage>,
        );

        for (const call of calls) expect(call.cancel).toHaveBeenCalled();
    });
});

describe('CountUp', () => {
    it('counts from the start value to the final value once, then holds it', () => {
        stubReducedMotion(false);
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const cancelFrame = vi.fn();
        vi.stubGlobal('cancelAnimationFrame', cancelFrame);

        const { container, unmount } = render(
            <SceneStage tone="blue" still={false}>
                <CountUp to={80} />
            </SceneStage>,
        );
        const shown = () => container.querySelector('[data-scene-count]')?.textContent;
        const tick = (time: number) => act(() => frames.shift()?.(time));

        tick(1000);
        expect(shown()).toBe('0');
        tick(1000 + SCENE_LOOP_MS * 0.3);
        const midway = Number(shown());
        expect(midway).toBeGreaterThan(0);
        expect(midway).toBeLessThan(80);
        tick(1000 + SCENE_LOOP_MS * 0.9);
        expect(shown()).toBe('80');
        // No second pass: the final value stays, and no more frames are asked for.
        tick(1000 + SCENE_LOOP_MS * 1.01);
        expect(shown()).toBe('80');
        expect(frames).toHaveLength(0);

        unmount();
        expect(cancelFrame).toHaveBeenCalled();
    });

    it('formats the value it shows', () => {
        const { getByText } = render(<CountUp to={3} format={(value) => `${value} of 7`} />);

        expect(getByText('3 of 7')).toBeInTheDocument();
    });
});

describe('pieces', () => {
    const PIECES: ReadonlyArray<[string, React.ReactElement]> = [
        ['SceneFrame', <SceneFrame key="f">x</SceneFrame>],
        ['SceneRow', <SceneRow key="r">x</SceneRow>],
        ['SceneChip', <SceneChip key="c">x</SceneChip>],
        ['SceneBubble', <SceneBubble key="b" side="start">x</SceneBubble>],
        ['SceneAvatar', <SceneAvatar key="a" initials="TW" />],
        ['SceneLabel', <SceneLabel key="l">x</SceneLabel>],
        ['SceneField', <SceneField key="d">x</SceneField>],
        ['SceneNote', <SceneNote key="m">x</SceneNote>],
        ['SlideIn', <SlideIn key="s">x</SlideIn>],
        ['TapPulse', <TapPulse key="t">x</TapPulse>],
        ['TypeOn', <TypeOn key="o">x</TypeOn>],
        ['CountUp', <CountUp key="n" to={1} />],
        ['SceneToggle', <SceneToggle key="g">x</SceneToggle>],
        ['SceneCycle', <SceneCycle key="y"><span>x</span></SceneCycle>],
        ['SceneSegments', <SceneSegments key="e" count={3} />],
        ['SceneClock', <SceneClock key="k" />],
    ];

    it.each(PIECES)('%s is hidden from assistive technology', (_name, element) => {
        const { container } = render(element);

        expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('builds a frame on the one card recipe', () => {
        const { container } = render(<SceneFrame>x</SceneFrame>);

        expect(container.querySelector('.rounded-\\[var\\(--radius-card\\)\\]')).not.toBeNull();
    });

    it('fills only the requested segments', () => {
        const { container } = render(<SceneSegments count={3} filled={1} />);

        expect(container.querySelectorAll('[data-scene-segment="filled"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-scene-segment="empty"]')).toHaveLength(2);
    });

    it('labels segments when asked', () => {
        const { getByText } = render(<SceneSegments count={3} labels={['Basics', 'Pay', 'Questions']} fill="pop" />);

        expect(getByText('Basics')).toBeInTheDocument();
        expect(getByText('Questions')).toBeInTheDocument();
    });

    it('draws a tinted note that wraps its text', () => {
        const { container } = render(<SceneNote tone="warning">Questions lock once someone applies.</SceneNote>);
        const note = container.firstElementChild as HTMLElement;

        expect(note).toHaveAttribute('aria-hidden', 'true');
        expect(note.className).toContain('var(--jale-warning-bg)');
        expect(note.className).not.toContain('whitespace-nowrap');
    });

    it('draws an empty slot as a dashed note', () => {
        const { container } = render(<SceneNote tone="empty">Driver license</SceneNote>);

        expect((container.firstElementChild as HTMLElement).className).toContain('border-dashed');
    });

    it('keeps a toggle that stays off still and unlit, even on a moving stage', () => {
        stubReducedMotion(false);
        const { animate } = stubAnimate();
        const { container } = render(
            <SceneStage tone="blue" still={false}>
                <SceneToggle on={false} shape="tile">
                    Night
                </SceneToggle>
            </SceneStage>,
        );
        const toggle = container.querySelector('[data-scene-toggle]') as HTMLElement;

        expect(animate).not.toHaveBeenCalled();
        expect(toggle).toHaveAttribute('data-scene-toggle', 'off');
        expect(toggle.className).not.toContain('var(--jale-blue-500)');
    });

    it('marks the current step with a teal ring', () => {
        const { container } = render(<SceneChip tone="current">Question 3</SceneChip>);

        expect((container.firstElementChild as HTMLElement).className).toContain('var(--jale-teal-500)');
    });

    it('puts a typing caret after a focused field', () => {
        const { container } = render(
            <SceneField focused caret>
                El Pa
            </SceneField>,
        );

        expect(container.querySelector('[data-scene-caret]')).not.toBeNull();
    });
});
