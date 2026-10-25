import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { Spotlight } from '../Spotlight';
import type { SpotlightStep } from '../steps';

/*
 * The spotlight engine's options that the app tour does not use, so a later
 * walkthrough can rely on them: no intro card, a target given as a function,
 * a preferred side, an interactive cutout the pointer and Tab reach, and a
 * step that moves on by itself once the person has typed. The copy keys are
 * borrowed from the catalogue; the engine owns none.
 */

beforeEach(() => {
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        return (this.closest('[data-hidden]') ? [] : [{}]) as unknown as DOMRectList;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const box =
            this.getAttribute('role') === 'dialog'
                ? { top: 0, left: 0, width: 358, height: 160 }
                : { top: 300, left: 600, width: 200, height: 40 };
        return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
});

afterEach(() => {
    vi.restoreAllMocks();
});

function Form() {
    return (
        <form>
            <button type="button" data-testid="opener">
                Opener
            </button>
            <label>
                Job title
                <input id="job-title" data-tour="job-title" />
            </label>
            <select data-tour="trade" defaultValue="">
                <option value="">Pick one</option>
                <option value="carpenter">Carpenter</option>
            </select>
        </form>
    );
}

const TITLE: SpotlightStep = {
    id: 'title',
    target: () => document.getElementById('job-title'),
    titleKey: 'tutorial.tour.employer.post_job_title',
    bodyKey: 'tutorial.tour.employer.post_job_body',
    placement: 'top',
    interactive: true,
    advanceWhen: (target) => (target as HTMLInputElement).value.trim().length > 0,
};

const TRADE: SpotlightStep = {
    id: 'trade',
    target: { selector: 'select[data-tour="trade"]' },
    titleKey: 'tutorial.tour.employer.templates_body',
    bodyKey: 'tutorial.tour.employer.billing_body',
};

function renderSpotlight(steps: SpotlightStep[], wrap: (node: ReactNode) => ReactNode = (node) => node) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    const view = (on: boolean) => (
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            <OverlayPresenceProvider>
                {wrap(<Form />)}
                {on ? <Spotlight name="test-walkthrough" steps={steps} onDismiss={onDismiss} onUnavailable={onUnavailable} /> : null}
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
    const result = render(view(false));
    result.rerender(view(true));
    return { ...result, onDismiss, onUnavailable };
}

describe('spotlight engine', () => {
    it('with no intro, opens straight on the first step', () => {
        renderSpotlight([TITLE, TRADE]);
        const dialog = screen.getByRole('dialog', { name: en.tutorial.tour.employer.post_job_title });
        expect(dialog).toHaveAttribute('data-step', 'title');
        expect(within(dialog).getByText('1 of 2')).toBeInTheDocument();
    });

    it('resolves a target given as a function, and honours a preferred side', () => {
        renderSpotlight([TITLE, TRADE]);
        expect(screen.getByRole('dialog')).toHaveAttribute('data-side', 'top');
    });

    it('lets the pointer through an interactive cutout, and blocks it over any other', () => {
        renderSpotlight([TITLE, TRADE]);
        const blockerKeys = () =>
            Array.from(document.querySelectorAll('[data-spotlight-blocker]')).map((node) => node.getAttribute('data-spotlight-blocker'));
        expect(blockerKeys()).toEqual(['above', 'below', 'left', 'right']);
        // The control is outside the callout, so the page is not declared inert.
        expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal');

        act(() => {
            fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next' }));
        });
        expect(screen.getByRole('dialog')).toHaveAttribute('data-step', 'trade');
        expect(blockerKeys()).toEqual(['above', 'below', 'left', 'right', 'hole']);
        expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('lets Tab reach the control on an interactive step', () => {
        renderSpotlight([TITLE, TRADE]);
        const input = document.getElementById('job-title') as HTMLInputElement;
        const dialog = screen.getByRole('dialog');
        const next = within(dialog).getByRole('button', { name: 'Next' });
        act(() => {
            next.focus();
            fireEvent.keyDown(next, { key: 'Tab' });
        });
        expect(document.activeElement).toBe(input);
        act(() => {
            fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
        });
        expect(document.activeElement).toBe(next);
    });

    it('moves on by itself once the person has typed into the control', () => {
        renderSpotlight([TITLE, TRADE]);
        const input = document.getElementById('job-title') as HTMLInputElement;

        act(() => {
            fireEvent.input(input, { target: { value: '   ' } });
        });
        expect(screen.getByRole('dialog')).toHaveAttribute('data-step', 'title');

        act(() => {
            fireEvent.input(input, { target: { value: 'Framer' } });
        });
        expect(screen.getByRole('dialog')).toHaveAttribute('data-step', 'trade');
    });

    it('is unavailable when no step has its control on screen', () => {
        const { onUnavailable } = renderSpotlight([TITLE, TRADE], (node) => <div data-hidden="">{node}</div>);
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
