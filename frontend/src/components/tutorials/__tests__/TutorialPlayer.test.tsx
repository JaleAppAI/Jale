import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import type { TutorialDefinition, TutorialSceneProps } from '@/lib/tutorials/types';
import { TutorialPlayer } from '../TutorialPlayer';
import { FIXTURE_MESSAGES, FIXTURE_REGISTRY, LABELLED_FIXTURE, sceneRenders } from './fixtures';

/*
 * The tutorial player (FE-1 §4.3, rulings R5 and R6): a Modal of 3–5 slides.
 * Back is hidden on the first slide, Skip on the last; the last slide's button
 * is "Got it" or the tutorial's own label; the X, Escape and the backdrop all
 * count as Skip. One primary button for the whole play, so focus never drops.
 */

const EMPLOYER = FIXTURE_REGISTRY.employer_post_job; // "Sample posting tour", no own last label
const WORKER = FIXTURE_REGISTRY.worker_apply;

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

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

function stubAnimate() {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    return animate;
}

beforeEach(() => {
    sceneRenders.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as { animate?: unknown }).animate;
});

function PlayerHost({
    definition,
    vars,
    onDismiss,
}: {
    definition: TutorialDefinition;
    vars?: TutorialSceneProps['vars'];
    onDismiss: (outcome: TutorialOutcome) => void;
}) {
    const [playing, setPlaying] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setPlaying(true)}>
                Open tour
            </button>
            {playing ? (
                <TutorialPlayer
                    definition={definition}
                    vars={vars}
                    onDismiss={(outcome) => {
                        onDismiss(outcome);
                        setPlaying(false);
                    }}
                />
            ) : null}
        </>
    );
}

function play(
    definition: TutorialDefinition = EMPLOYER,
    { locale = 'en', vars }: { locale?: 'en' | 'es'; vars?: TutorialSceneProps['vars'] } = {},
) {
    const onDismiss = vi.fn();
    const messages = { ...(locale === 'en' ? en : es), ...FIXTURE_MESSAGES[locale] };
    const view = render(
        <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
            <PlayerHost definition={definition} vars={vars} onDismiss={onDismiss} />
        </NextIntlClientProvider>,
    );
    const opener = screen.getByRole('button', { name: 'Open tour' });
    opener.focus();
    act(() => opener.click());
    return { ...view, onDismiss, opener, dialog: screen.getByRole('dialog') };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });

describe('chrome', () => {
    it('is a dialog named by the tutorial title', () => {
        play();

        expect(screen.getByRole('dialog', { name: 'Sample posting tour' })).toBeInTheDocument();
    });

    it('opens on slide 1 with focus on Next, no Back, and Skip and Close available', () => {
        play();

        expect(screen.getByText('1 of 3')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Step one' })).toBeInTheDocument();
        expect(screen.getByText('What step one shows.')).toBeInTheDocument();
        expect(document.activeElement).toBe(button('Next'));
        expect(queryButton('Back')).toBeNull();
        expect(button('Skip')).toBeInTheDocument();
        expect(button('Close')).toBeInTheDocument();
    });

    it('keeps one primary button across slides, ending on Got it with no Skip', () => {
        play();
        const primary = button('Next');

        act(() => primary.click());
        expect(screen.getByText('2 of 3')).toBeInTheDocument();
        expect(button('Back')).toBeInTheDocument();
        expect(button('Next')).toBe(primary);
        expect(document.activeElement).toBe(primary);

        act(() => primary.click());
        expect(screen.getByText('3 of 3')).toBeInTheDocument();
        expect(button('Got it')).toBe(primary);
        expect(queryButton('Skip')).toBeNull();
        expect(button('Close')).toBeInTheDocument();
        expect(document.activeElement).toBe(primary);
    });

    it('uses the tutorial’s own last label when it has one', () => {
        play(LABELLED_FIXTURE, { vars: { limit: 15 } });
        act(() => button('Next').click());
        act(() => button('Next').click());

        expect(button('Start')).toBeInTheDocument();
        expect(queryButton('Got it')).toBeNull();
    });

    it('speaks Spanish in the Spanish locale', () => {
        play(LABELLED_FIXTURE, { locale: 'es', vars: { limit: 15 } });

        expect(screen.getByRole('dialog', { name: 'Recorrido con botón propio' })).toBeInTheDocument();
        expect(screen.getByText('1 de 3')).toBeInTheDocument();
        expect(button('Omitir')).toBeInTheDocument();
        expect(button('Cerrar')).toBeInTheDocument();
        act(() => button('Siguiente').click());
        expect(button('Atrás')).toBeInTheDocument();
        act(() => button('Siguiente').click());
        expect(button('Empezar')).toBeInTheDocument();
    });

    it('ends Spanish plays without an own label on Entendido', () => {
        play(EMPLOYER, { locale: 'es' });
        act(() => button('Siguiente').click());
        act(() => button('Siguiente').click());

        expect(button('Entendido')).toBeInTheDocument();
    });

    it('reads the slide’s title and body from a polite live region', () => {
        play();
        const region = screen.getByText('What step one shows.').closest('[aria-live]');

        expect(region).toHaveAttribute('aria-live', 'polite');
        expect(region).toHaveTextContent('1 of 3');
        expect(region).toHaveTextContent('Step one');
    });

    it('describes the primary button with the current slide, for the focus that lands on it', () => {
        play();

        expect(button('Next')).toHaveAccessibleDescription(/Step one/);
        act(() => button('Next').click());
        expect(button('Next')).toHaveAccessibleDescription(/Step two/);
    });

    it('fills a message’s placeholders from the host’s vars, and hands the vars to the scene', () => {
        play(LABELLED_FIXTURE, { vars: { limit: 15 } });

        expect(screen.getByText('Up to 15 active jobs.')).toBeInTheDocument();
        expect(sceneRenders.at(-1)?.vars).toEqual({ limit: 15 });
    });

    it('draws employer scenes on blue and worker scenes on teal', () => {
        const employer = play(EMPLOYER);
        expect(employer.dialog.querySelector('[data-scene-stage]')?.className).toContain('var(--jale-blue-50)');
        employer.unmount();

        const worker = play(WORKER);
        expect(worker.dialog.querySelector('[data-scene-stage]')?.className).toContain('var(--jale-teal-50)');
    });
});

describe('dismissing', () => {
    it('finishes with "completed" from the last slide’s button', () => {
        const { onDismiss } = play();
        act(() => button('Next').click());
        act(() => button('Next').click());

        act(() => button('Got it').click());

        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('completed');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it.each([
        ['Skip', () => act(() => button('Skip').click())],
        ['the close X', () => act(() => button('Close').click())],
        ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
        [
            'a backdrop press',
            () => {
                const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
                fireEvent.mouseDown(backdrop);
                fireEvent.click(backdrop);
            },
        ],
    ])('skips with "skipped" from %s', (_way, dismiss) => {
        const { onDismiss } = play();

        dismiss();

        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('closes the X as a skip on the last slide too', () => {
        const { onDismiss } = play();
        act(() => button('Next').click());
        act(() => button('Next').click());

        act(() => button('Close').click());

        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('returns focus to whatever opened it', () => {
        const { opener } = play();

        act(() => button('Skip').click());

        expect(document.activeElement).toBe(opener);
    });

    it('keeps Escape inside the tutorial: the page behind never hears it', () => {
        const pageListener = vi.fn();
        window.addEventListener('keydown', pageListener);
        const { onDismiss } = play();

        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(pageListener).not.toHaveBeenCalled();
        window.removeEventListener('keydown', pageListener);
    });
});

describe('keyboard and focus', () => {
    it('moves with the arrow keys, and stops at either end', () => {
        play();

        fireEvent.keyDown(document, { key: 'ArrowLeft' });
        expect(screen.getByText('1 of 3')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'ArrowRight' });
        expect(screen.getByText('2 of 3')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'ArrowRight' });
        fireEvent.keyDown(document, { key: 'ArrowRight' });
        expect(screen.getByText('3 of 3')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'ArrowLeft' });
        expect(screen.getByText('2 of 3')).toBeInTheDocument();
    });

    it('ignores the arrows when a modifier is held', () => {
        play();

        fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true });

        expect(screen.getByText('1 of 3')).toBeInTheDocument();
    });

    it('keeps Tab inside the dialog', () => {
        play();
        const primary = button('Next');
        primary.focus();

        fireEvent.keyDown(document, { key: 'Tab' });

        expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
        expect(document.activeElement).not.toBe(primary);
    });

    it('moves focus to the primary button when Back disappears under it', () => {
        play();
        act(() => button('Next').click());
        const back = button('Back');
        back.focus();

        act(() => back.click());

        expect(queryButton('Back')).toBeNull();
        expect(document.activeElement).toBe(button('Next'));
    });

    it('moves focus to the primary button when Skip disappears under it', () => {
        play();
        act(() => button('Next').click());
        button('Skip').focus();

        fireEvent.keyDown(document, { key: 'ArrowRight' });

        expect(queryButton('Skip')).toBeNull();
        expect(document.activeElement).toBe(button('Got it'));
    });
});

describe('swiping', () => {
    function swipe(pointerType: string, fromX: number, toX: number, fromY = 100, toY = 100) {
        const region = screen.getByRole('dialog').querySelector('[data-tutorial-swipe]') as HTMLElement;
        fireEvent.pointerDown(region, { pointerId: 1, pointerType, clientX: fromX, clientY: fromY });
        fireEvent.pointerUp(region, { pointerId: 1, pointerType, clientX: toX, clientY: toY });
    }

    it('goes forward on a left swipe and back on a right swipe', () => {
        play();

        swipe('touch', 220, 140);
        expect(screen.getByText('2 of 3')).toBeInTheDocument();

        swipe('touch', 140, 220);
        expect(screen.getByText('1 of 3')).toBeInTheDocument();
    });

    it('ignores short swipes, mostly vertical ones, and mouse drags', () => {
        play();

        swipe('touch', 220, 190);
        swipe('touch', 220, 160, 100, 260);
        swipe('mouse', 220, 100);

        expect(screen.getByText('1 of 3')).toBeInTheDocument();
    });
});

describe('motion', () => {
    /** The element that changes per slide (Modal's own panel fades in too, so look at this one). */
    const slideWrapper = (dialog: HTMLElement) => dialog.querySelector('[data-scene-stage]')?.parentElement;

    it('passes still to the scene and starts no animation when reduced motion is asked for', () => {
        stubReducedMotion(true);
        const animate = stubAnimate();

        const { dialog } = play();

        expect(sceneRenders.length).toBeGreaterThan(0);
        expect(sceneRenders.every((props) => props.still === true)).toBe(true);
        expect(animate).not.toHaveBeenCalled();
        expect(slideWrapper(dialog)).not.toHaveClass('anim-fade-in');
    });

    it('animates the scene and the slide change otherwise', () => {
        stubReducedMotion(false);
        const animate = stubAnimate();

        const { dialog } = play();

        expect(sceneRenders.at(-1)?.still).toBe(false);
        expect(animate).toHaveBeenCalled();
        expect(slideWrapper(dialog)).toHaveClass('anim-fade-in');
    });

    it('plays a slide’s scene once, and again when the slide is revisited', () => {
        stubReducedMotion(false);
        const animate = stubAnimate();
        const options = () =>
            (animate.mock.calls as unknown as Array<[Keyframe[], KeyframeAnimationOptions]>).map(([, value]) => value);

        play();
        const firstVisit = animate.mock.calls.length;
        act(() => button('Next').click());
        const secondSlide = animate.mock.calls.length;
        act(() => button('Back').click());

        expect(firstVisit).toBeGreaterThan(0);
        expect(secondSlide).toBeGreaterThan(firstVisit);
        // Back on slide 1: its scene starts over.
        expect(animate.mock.calls.length).toBeGreaterThan(secondSlide);
        expect(options().every((value) => value.iterations === 1)).toBe(true);
    });

    it('works where there is no matchMedia at all', () => {
        expect(() => play()).not.toThrow();
        expect(sceneRenders.at(-1)?.still).toBe(false);
    });
});
