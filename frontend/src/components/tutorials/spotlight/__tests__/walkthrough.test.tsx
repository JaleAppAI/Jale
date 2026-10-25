import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { Modal } from '@/components/ui/modal';
import { VIEWPORT_GUTTER } from '../geometry';
import { Spotlight } from '../Spotlight';
import type { SpotlightDone, SpotlightIntro, SpotlightStep } from '../steps';

/*
 * The spotlight engine's lazy mode: the task walkthroughs' rules, over a stand-in
 * form (and the same form inside a real `Modal`, the way the post-job wizard
 * holds it). jsdom does no layout, so each control carries its box in
 * `data-box` ("top,left,width,height"), and anything inside `data-hidden`
 * reports no boxes, the way a control that is not rendered does.
 *
 * Copy comes from the catalogue: the post-job guide's own keys.
 */

const KEY = 'tutorial.employer_post_job.guide';
const COUNTER = `${KEY}.counter`;

/** How far the page has been scrolled (a `window.scrollBy` stub moves it); fixed chrome stays put. */
let pageScroll = 0;

function boxOf(element: Element): { top: number; left: number; width: number; height: number } {
    const raw = element.getAttribute('data-box');
    if (raw) {
        const [top, left, width, height] = raw.split(',').map(Number);
        return { top: top - (element.closest('[data-fixed]') ? 0 : pageScroll), left, width, height };
    }
    if (element.getAttribute('role') === 'dialog' && element.closest('[data-spotlight]')) {
        return { top: 0, left: 0, width: 326, height: 160 };
    }
    return { top: 0, left: 0, width: 0, height: 0 };
}

beforeEach(() => {
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        return (this.closest('[data-hidden]') ? [] : [{}]) as unknown as DOMRectList;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const box = boxOf(this);
        return {
            ...box,
            x: box.left,
            y: box.top,
            right: box.left + box.width,
            bottom: box.top + box.height,
            toJSON: () => box,
        } as DOMRect;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    pageScroll = 0;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // What a hit-testing test set up, even when it failed before undoing it.
    delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    document.documentElement.style.removeProperty('--jale-tab-bar-offset');
});

/** Lets the page-watching observers and short waits run. */
async function flush(ms = 0) {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

type FormProps = {
    /** Which fields are rendered at all. */
    fields?: { title?: boolean; trade?: boolean; other?: boolean; city?: boolean };
    /** The city's suggestion list is open (`aria-expanded`, `aria-controls`). */
    listOpen?: boolean;
};

function Form({ fields = { title: true, trade: true, city: true }, listOpen = false }: FormProps) {
    return (
        <form>
            {fields.title ? (
                <div data-guide="t.title" data-box="100,40,300,70">
                    <label htmlFor="title">Job title</label>
                    <input id="title" />
                </div>
            ) : null}
            {fields.trade ? (
                <div data-guide="t.trade" data-box="200,40,300,70">
                    <select aria-label="Trade" defaultValue="">
                        <option value="">Pick one</option>
                        <option value="carpenter">Carpenter</option>
                        <option value="other">Other</option>
                    </select>
                </div>
            ) : null}
            {fields.other ? (
                <div data-guide="t.other" data-box="280,40,300,70">
                    <input aria-label="Other trade" />
                </div>
            ) : null}
            {fields.city ? (
                <div data-guide="t.city" data-box="360,40,300,70">
                    <input
                        aria-label="City"
                        role="combobox"
                        aria-expanded={listOpen}
                        aria-controls={listOpen ? 'city-list' : undefined}
                    />
                    {listOpen ? (
                        <ul id="city-list" role="listbox" data-box="440,40,300,200">
                            <li role="option" aria-selected={false}>
                                Hayward, CA
                            </li>
                        </ul>
                    ) : null}
                </div>
            ) : null}
            <button type="button" data-guide="t.submit" data-box="700,40,120,44">
                Submit
            </button>
        </form>
    );
}

const value = (selector: string) =>
    (document.querySelector(selector) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';

const copy = (id: string) => ({
    titleKey: `${KEY}.steps.${id}.title`,
    bodyKey: `${KEY}.steps.${id}.body`,
    waitKey: `${KEY}.steps.${id}.wait`,
});

const TITLE: SpotlightStep = {
    id: 'title',
    target: { guide: 't.title' },
    mode: 'next',
    ready: () => value('#title').trim() !== '',
    ...copy('title'),
};
const TRADE: SpotlightStep = {
    id: 'trade',
    target: { guide: 't.trade' },
    mode: 'auto',
    advanceWhen: () => value('[data-guide="t.trade"] select') !== '',
    ...copy('trade'),
};
const OTHER: SpotlightStep = {
    id: 'trade_other',
    target: { guide: 't.other' },
    when: () => value('[data-guide="t.trade"] select') === 'other',
    mode: 'next',
    ready: () => value('[data-guide="t.other"] input').trim() !== '',
    ...copy('trade_other'),
};
const CITY: SpotlightStep = {
    id: 'city',
    target: { guide: 't.city' },
    mode: 'auto',
    advanceWhen: (target) => target.hasAttribute('data-picked'),
    ...copy('city'),
};

const INTRO: SpotlightIntro = {
    eyebrowKey: 'tutorial.employer_post_job.title',
    titleKey: `${KEY}.intro_title`,
    bodyKey: `${KEY}.intro_body`,
    startKey: 'tutorial.common.guide.employer.start',
    notNowKey: 'tutorial.common.guide.self',
    muteKey: 'tutorial.help_center.mute',
};

type Options = {
    intro?: SpotlightIntro;
    done?: SpotlightDone;
    onMute?: () => void;
    waitMs?: number;
};

function Intl({ children }: { children: ReactNode }) {
    return (
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            <OverlayPresenceProvider>{children}</OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
}

/** The walkthrough over the stand-in form, on the page. `view(page)` re-renders with another form. */
function renderGuide(steps: SpotlightStep[], form: FormProps = {}, options: Options = {}) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    const view = (page: FormProps) => (
        <Intl>
            <Form {...page} />
            <Spotlight
                name="test-guide"
                resolve="lazy"
                steps={steps}
                intro={options.intro}
                done={options.done}
                onMute={options.onMute}
                waitMs={options.waitMs ?? 50}
                counterKey={COUNTER}
                endKey="tutorial.common.guide.end"
                onDismiss={onDismiss}
                onUnavailable={onUnavailable}
            />
        </Intl>
    );
    const result = render(view(form));
    return { ...result, onDismiss, onUnavailable, show: (page: FormProps) => result.rerender(view(page)) };
}

const callout = () => document.querySelector<HTMLElement>('[data-spotlight] [role="dialog"]');
const stepOf = () => callout()?.getAttribute('data-step') ?? null;
const counter = () => callout()?.querySelector('p')?.textContent ?? null;
const action = (name: string) => callout()?.querySelector<HTMLButtonElement>(`[data-spotlight-action="${name}"]`) ?? null;
const press = (name: string) =>
    act(() => {
        fireEvent.click(action(name) as HTMLElement);
    });
const pick = (selector: string, next: string) =>
    act(() => {
        const field = document.querySelector(selector) as HTMLSelectElement;
        field.value = next;
        fireEvent.change(field);
    });
const type = (selector: string, text: string) =>
    act(() => {
        fireEvent.input(document.querySelector(selector) as HTMLInputElement, { target: { value: text } });
    });

describe('lazy walkthrough: finding the controls', () => {
    it('draws nothing until the first control is on screen, then starts there', async () => {
        const { show, onUnavailable } = renderGuide([TITLE, TRADE], { fields: {} });
        await flush();
        expect(callout()).toBeNull();
        expect(document.querySelector('[data-spotlight]')).toBeNull();

        show({ fields: { title: true, trade: true } });
        await flush();
        expect(stepOf()).toBe('title');
        expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('is unavailable, with nothing drawn and no outcome, when the first control never shows', async () => {
        const { onUnavailable, onDismiss } = renderGuide([TITLE, TRADE], { fields: {} }, { waitMs: 60 });
        await flush();
        // It waits first: the host may still be opening.
        expect(onUnavailable).not.toHaveBeenCalled();
        await flush(90);
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(callout()).toBeNull();
    });

    it('waits for a later step’s control and shows the step once it comes', async () => {
        const { show } = renderGuide([TITLE, OTHER, TRADE], { fields: { title: true, trade: true } }, { waitMs: 500 });
        await flush();
        type('#title', 'Framer');
        pick('[data-guide="t.trade"] select', 'other');
        press('next');
        await flush();
        // Other applies, but its box is not on screen yet: nothing drawn, waiting.
        expect(callout()).toBeNull();

        show({ fields: { title: true, trade: true, other: true } });
        await flush();
        expect(stepOf()).toBe('trade_other');
    });

    it('skips a step whose control never comes', async () => {
        const { onDismiss } = renderGuide([TITLE, OTHER, TRADE], { fields: { title: true, trade: true } }, { waitMs: 30 });
        await flush();
        type('#title', 'Framer');
        pick('[data-guide="t.trade"] select', 'other');
        press('next');
        await flush(60);
        expect(stepOf()).toBe('trade');
        expect(onDismiss).not.toHaveBeenCalled();
    });
});

describe('lazy walkthrough: conditional steps and the live counter', () => {
    it('skips a step whose `when` is false when it is reached', async () => {
        renderGuide([TRADE, OTHER, CITY]);
        await flush();
        pick('[data-guide="t.trade"] select', 'carpenter');
        await flush();
        expect(stepOf()).toBe('city');
    });

    it('counts the steps that apply now, and the count follows a branch', async () => {
        const { show } = renderGuide([TRADE, OTHER, CITY]);
        await flush();
        expect(counter()).toBe('Posting a job · 1 of 2');

        pick('[data-guide="t.trade"] select', 'other');
        show({ fields: { title: true, trade: true, other: true, city: true } });
        await flush();
        expect(stepOf()).toBe('trade_other');
        expect(counter()).toBe('Posting a job · 2 of 3');
    });

    it('keeps counting a step the person was shown after its control has gone', async () => {
        const { show } = renderGuide([TRADE, OTHER, CITY], { fields: { trade: true, other: true, city: true } });
        await flush();
        pick('[data-guide="t.trade"] select', 'other');
        await flush();
        type('[data-guide="t.other"] input', 'Welder');
        press('next');
        await flush();
        expect(stepOf()).toBe('city');
        expect(counter()).toBe('Posting a job · 3 of 3');

        // The trade and Other fields leave the screen (the next screen of a wizard).
        show({ fields: { city: true } });
        await flush();
        expect(counter()).toBe('Posting a job · 3 of 3');
    });
});

/**
 * A page whose Post button is replaced by the posted screen (marked
 * `data-posted`) when pressed, at once or, with `later`, a moment after.
 */
function Posting({ later }: { later: boolean }) {
    const [posted, setPosted] = useState(false);
    const [marked, setMarked] = useState(false);
    useEffect(() => {
        if (!posted || !later) return;
        const timer = setTimeout(() => setMarked(true), 20);
        return () => clearTimeout(timer);
    }, [posted, later]);
    if (!posted) {
        return (
            <button type="button" data-guide="t.post" data-box="700,40,120,44" onClick={() => setPosted(true)}>
                Post
            </button>
        );
    }
    return (
        <div data-posted={!later || marked ? '' : undefined}>
            <div data-guide="t.after" data-box="100,40,300,70">
                <input aria-label="Workers" />
            </div>
        </div>
    );
}

const POST: SpotlightStep = {
    id: 'next',
    target: { guide: 't.post' },
    mode: 'action',
    advanceWhen: () => document.querySelector('[data-posted]') !== null,
    ...copy('next'),
};
const AFTER: SpotlightStep = { id: 'workers', target: { guide: 't.after' }, mode: 'next', ready: () => true, ...copy('workers') };

/** POST then AFTER over `Posting`, with a wait long enough that a re-wait would still be waiting. */
function renderPosting({ later = false }: { later?: boolean } = {}) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    render(
        <Intl>
            <Posting later={later} />
            <Spotlight
                name="test-guide"
                resolve="lazy"
                steps={[POST, AFTER]}
                waitMs={10_000}
                counterKey={COUNTER}
                endKey="tutorial.common.guide.end"
                onDismiss={onDismiss}
                onUnavailable={() => {}}
            />
        </Intl>,
    );
    return { onDismiss };
}

describe('lazy walkthrough: the three modes', () => {
    it('next: Next waits for `ready`, with the wait line, then moves on', async () => {
        renderGuide([TITLE, TRADE]);
        await flush();
        expect(action('next')).toBeDisabled();
        expect(callout()?.querySelector('[data-spotlight-wait]')?.textContent).toBe(en.tutorial.employer_post_job.guide.steps.title.wait);

        type('#title', 'Framer');
        expect(action('next')).not.toBeDisabled();
        expect(callout()?.querySelector('[data-spotlight-wait]')).toBeNull();
        press('next');
        await flush();
        expect(stepOf()).toBe('trade');
    });

    it('auto: no Next, and it moves on by itself once the person picks', async () => {
        renderGuide([TRADE, CITY]);
        await flush();
        expect(action('next')).toBeNull();
        pick('[data-guide="t.trade"] select', 'carpenter');
        await flush();
        expect(stepOf()).toBe('city');
    });

    it('auto: moves on when the page marks the pick, with no event on the control', async () => {
        const { onDismiss } = renderGuide([TITLE, CITY]);
        await flush();
        type('#title', 'Framer');
        press('next');
        await flush();
        expect(stepOf()).toBe('city');
        // A suggestion picked from a list sets the mark from outside the field's own events.
        act(() => {
            document.querySelector('[data-guide="t.city"]')?.setAttribute('data-picked', '');
        });
        await flush();
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('auto: a person who came Back sees Next, and a click does not move them on by itself', async () => {
        renderGuide([TRADE, TITLE]);
        await flush();
        pick('[data-guide="t.trade"] select', 'carpenter');
        await flush();
        expect(stepOf()).toBe('title');
        press('back');
        await flush();
        expect(stepOf()).toBe('trade');
        expect(action('next')).not.toBeNull();
        act(() => {
            fireEvent.click(document.querySelector('[data-guide="t.trade"] select') as HTMLElement);
        });
        await flush();
        expect(stepOf()).toBe('trade');
    });

    it('action: no Next, a wait line, and a click on the control completes it', async () => {
        const SUBMIT: SpotlightStep = { id: 'next', target: { guide: 't.submit' }, mode: 'action', ...copy('next') };
        const { onDismiss } = renderGuide([SUBMIT]);
        await flush();
        expect(action('next')).toBeNull();
        expect(callout()?.querySelector('[data-spotlight-wait]')).not.toBeNull();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
        });
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('action with a condition: a click alone does not complete it; the page moving on does', async () => {
        const SUBMIT: SpotlightStep = {
            id: 'next',
            target: { guide: 't.submit' },
            mode: 'action',
            advanceWhen: () => document.body.hasAttribute('data-moved-on'),
            ...copy('next'),
        };
        const { onDismiss } = renderGuide([SUBMIT]);
        await flush();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
        });
        await flush();
        expect(onDismiss).not.toHaveBeenCalled();

        act(() => {
            document.body.setAttribute('data-moved-on', '');
        });
        await flush();
        document.body.removeAttribute('data-moved-on');
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('action: a control the page replaces as it moves on completes the step, with no wait', async () => {
        const { onDismiss } = renderPosting();
        await flush();
        expect(stepOf()).toBe('next');
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Post' }));
        });
        await flush();
        // The button left in the same change that marked the page posted.
        expect(stepOf()).toBe('workers');
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('action: a control that went before the page moved on completes the step once it does', async () => {
        renderPosting({ later: true });
        await flush();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Post' }));
        });
        await flush();
        expect(stepOf()).toBeNull();
        await flush(40);
        expect(stepOf()).toBe('workers');
    });

    it('Back never crosses an action step', async () => {
        const SUBMIT: SpotlightStep = { id: 'next', target: { guide: 't.submit' }, mode: 'action', ...copy('next') };
        renderGuide([TRADE, SUBMIT, TITLE]);
        await flush();
        pick('[data-guide="t.trade"] select', 'carpenter');
        await flush();
        expect(action('back')).not.toBeNull();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
        });
        await flush();
        expect(stepOf()).toBe('title');
        expect(action('back')).toBeNull();
    });
});

describe('lazy walkthrough: intro, ending and focus', () => {
    it('intro: Guide me starts, and "I’ll do it myself" ends it as skipped', async () => {
        const first = renderGuide([TITLE], {}, { intro: INTRO });
        await flush();
        expect(stepOf()).toBe('intro');
        expect(screen.getByRole('dialog', { name: en.tutorial.employer_post_job.guide.intro_title })).toBeInTheDocument();
        expect(action('mute')).toBeNull();
        press('start');
        await flush();
        expect(stepOf()).toBe('title');
        first.unmount();

        const second = renderGuide([TITLE], {}, { intro: INTRO });
        await flush();
        press('not-now');
        expect(second.onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('intro: "Don’t show this again" only when offered, and it mutes and ends as skipped', async () => {
        const onMute = vi.fn();
        const { onDismiss } = renderGuide([TITLE], {}, { intro: INTRO, onMute });
        await flush();
        expect(action('mute')?.textContent).toBe(en.tutorial.help_center.mute);
        press('mute');
        expect(onMute).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('the last step done completes it, once; ending earlier is skipped', async () => {
        const done = renderGuide([TITLE]);
        await flush();
        type('#title', 'Framer');
        expect(within(callout() as HTMLElement).getByRole('button', { name: 'Got it' })).toBe(action('next'));
        press('next');
        expect(done.onDismiss).toHaveBeenCalledTimes(1);
        expect(done.onDismiss).toHaveBeenCalledWith('completed');
        done.unmount();

        const ended = renderGuide([TITLE, TRADE]);
        await flush();
        expect(action('end')?.textContent).toBe('End guide');
        press('end');
        expect(ended.onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('a closing card follows the last step, and closing it completes the guide', async () => {
        const { onDismiss } = renderGuide([TRADE], {}, { done: { titleKey: `${KEY}.intro_title`, bodyKey: `${KEY}.intro_body` } });
        await flush();
        pick('[data-guide="t.trade"] select', 'carpenter');
        await flush();
        expect(stepOf()).toBe('done');
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        });
        expect(onDismiss).toHaveBeenCalledWith('completed');
    });

    it('a `next` step takes focus into the callout; an `auto` step leaves it in the control', async () => {
        renderGuide([TITLE, TRADE]);
        await flush();
        expect(callout()?.contains(document.activeElement)).toBe(true);
        const select = document.querySelector('[data-guide="t.trade"] select') as HTMLSelectElement;
        type('#title', 'Framer');
        press('next');
        await flush();
        expect(stepOf()).toBe('trade');
        act(() => select.focus());
        await flush();
        expect(document.activeElement).toBe(select);
        // Announced instead, since focus does not move there.
        expect(document.querySelector('[data-spotlight] [aria-live]')?.textContent).toContain(
            en.tutorial.employer_post_job.guide.steps.trade.title,
        );
    });

    it('takes an open list into the cutout', async () => {
        renderGuide([CITY], { fields: { city: true }, listOpen: true });
        await flush();
        const ring = document.querySelector<HTMLElement>('[data-spotlight-ring]');
        // The field (360..430) and its list (440..640), plus the 6px pad.
        expect(ring?.style.top).toBe('354px');
        expect(ring?.style.height).toBe('292px');
    });
});

/** The stand-in form inside a real Modal, the way the post-job wizard holds it. */
function renderInDialog(steps: SpotlightStep[], form: FormProps = {}, options: Options = {}) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onClose = vi.fn();
    function Page({ guide }: { guide: boolean }) {
        const [open, setOpen] = useState(true);
        return (
            <>
                <button type="button" onClick={() => setOpen(false)}>
                    Close from outside
                </button>
                <Modal
                    open={open}
                    onClose={() => {
                        onClose();
                        setOpen(false);
                    }}
                    title="Post a Job"
                    data-guide="t.wizard"
                    footerGuide="t.footer"
                    footer={<button type="button">Cancel</button>}
                >
                    <Form {...form} />
                </Modal>
                {guide ? (
                    <Spotlight
                        name="test-guide"
                        resolve="lazy"
                        steps={steps}
                        intro={options.intro}
                        waitMs={options.waitMs ?? 50}
                        counterKey={COUNTER}
                        endKey="tutorial.common.guide.end"
                        onDismiss={onDismiss}
                        onUnavailable={() => {}}
                    />
                ) : null}
            </>
        );
    }
    const result = render(
        <Intl>
            <Page guide />
        </Intl>,
    );
    // The play has ended: the provider stops drawing the guide.
    const dropGuide = () =>
        result.rerender(
            <Intl>
                <Page guide={false} />
            </Intl>,
        );
    return { ...result, onDismiss, onClose, dropGuide };
}

const panel = () => document.querySelector<HTMLElement>('[data-guide="t.wizard"]');

describe('inside a dialog', () => {
    it('draws inside the dialog panel, and leaves the scroll lock to the dialog', async () => {
        const { onDismiss } = renderInDialog([TITLE, TRADE]);
        await flush();
        expect(document.body.style.overflow).toBe('hidden');
        const layer = document.querySelector('[data-spotlight]');
        expect(layer).not.toBeNull();
        expect(panel()?.contains(layer)).toBe(true);
        expect(panel()?.querySelector('[data-guide="t.footer"]')).not.toBeNull();

        press('end');
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        // The dialog is still up, and still holds its lock.
        expect(document.body.style.overflow).toBe('hidden');
    });

    it('Escape ends the guide only: the dialog stays open, and a later Escape is the dialog’s again', async () => {
        const { onDismiss, onClose, dropGuide } = renderInDialog([TITLE, TRADE]);
        await flush();
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        });
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(onClose).not.toHaveBeenCalled();
        expect(panel()).not.toBeNull();

        dropGuide();
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('an Escape meant for an open list is left to the control, and the dialog skips it too', async () => {
        const { onDismiss, onClose } = renderInDialog([CITY], { fields: { city: true }, listOpen: true });
        await flush();
        const combobox = screen.getByRole('combobox', { name: 'City' });
        act(() => combobox.focus());
        let event: KeyboardEvent | null = null;
        const seen = (e: KeyboardEvent) => {
            event = e;
        };
        combobox.addEventListener('keydown', seen);
        act(() => {
            fireEvent.keyDown(combobox, { key: 'Escape' });
        });
        // It reached the control, marked handled, and nobody closed.
        expect(event).not.toBeNull();
        expect((event as unknown as KeyboardEvent).defaultPrevented).toBe(true);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Tab reaches the callout under the dialog’s focus trap, and cycles through the callout and the control', async () => {
        renderInDialog([TITLE, TRADE]);
        await flush();
        const title = document.getElementById('title') as HTMLInputElement;
        act(() => title.focus());
        act(() => {
            fireEvent.keyDown(title, { key: 'Tab' });
        });
        expect(callout()?.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(action('end'));

        // Next is disabled until a title: the cycle is the field and End guide.
        act(() => {
            fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
        });
        expect(document.activeElement).toBe(title);
        act(() => {
            fireEvent.keyDown(title, { key: 'Tab', shiftKey: true });
        });
        expect(document.activeElement).toBe(action('end'));
    });

    it('ends as skipped when the dialog is closed under it and no next step shows', async () => {
        const { onDismiss } = renderInDialog([TITLE, TRADE]);
        await flush();
        expect(callout()).not.toBeNull();
        // The page closes the dialog (the pointer cannot reach this under the
        // scrim; a route change or the host's own logic can).
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Close from outside' }));
        });
        await flush();
        expect(panel()).toBeNull();
        // It looks for this step's control or the next one's, the lazy way, first.
        expect(onDismiss).not.toHaveBeenCalled();
        await flush(80);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(document.body.style.overflow).toBe('');
        expect(document.documentElement.style.overflow).toBe('');
    });

    /** The callout's box and the ring's, as drawn (the callout measures 326 x 160 here). */
    const drawn = () => {
        const card = callout() as HTMLElement;
        const ring = document.querySelector<HTMLElement>('[data-spotlight-ring]') as HTMLElement;
        const px = (value: string) => Number.parseFloat(value);
        return {
            card: { top: px(card.style.top), left: px(card.style.left), width: 326, height: 160 },
            ring: { top: px(ring.style.top), left: px(ring.style.left), width: px(ring.style.width), height: px(ring.style.height) },
        };
    };
    const runInto = (a: { top: number; left: number; width: number; height: number }, b: typeof a) =>
        Math.max(
            0,
            Math.min(
                Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
                Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top),
            ),
        );
    /** Gives the dialog's scrolling body a box, and the title field another, and lets the guide measure again. */
    const layOut = async (body: string, title: string) => {
        act(() => {
            const scroller = panel()?.querySelector<HTMLElement>('.overflow-y-auto');
            // jsdom has no stylesheet: the body says it scrolls itself.
            scroller?.style.setProperty('overflow-y', 'auto');
            scroller?.setAttribute('data-box', body);
            document.querySelector('[data-guide="t.title"]')?.setAttribute('data-box', title);
        });
        await flush();
        await flush();
    };

    it('with no room in the body that cannot scroll, the callout goes past it rather than over the field', async () => {
        renderInDialog([TITLE]);
        await flush();
        // A 200px body; the field in its middle; the callout fits neither above nor below in it.
        await layOut('250,320,640,200', '300,330,590,50');
        const { card, ring } = drawn();
        expect(runInto(card, ring)).toBeLessThanOrEqual(4);
        expect(card.top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
        expect(card.top + card.height).toBeLessThanOrEqual(800 - VIEWPORT_GUTTER);
    });

    it('a field taller than the body: the ring keeps to the body, and the callout keeps off it', async () => {
        renderInDialog([TITLE]);
        await flush();
        await layOut('250,320,640,200', '200,330,590,700');
        const { card, ring } = drawn();
        expect(ring.top).toBeGreaterThanOrEqual(250);
        expect(ring.top + ring.height).toBeLessThanOrEqual(450);
        expect(runInto(card, ring)).toBeLessThanOrEqual(4);
    });

    it('the intro sits inside the dialog too', async () => {
        renderInDialog([TITLE], {}, { intro: INTRO });
        await flush();
        expect(stepOf()).toBe('intro');
        expect(panel()?.contains(callout())).toBe(true);
        expect(document.activeElement).toBe(action('start'));
    });
});

/**
 * A page with a button that opens a dialog and a field of its own; the
 * dialog has a field and a Save that closes it. The walkthrough is drawn
 * until it ends, as the progress provider draws a play.
 */
function renderCrossing(steps: SpotlightStep[], { open = false, done }: { open?: boolean; done?: SpotlightDone } = {}) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    function Page() {
        const [dialog, setDialog] = useState(open);
        const [playing, setPlaying] = useState(true);
        return (
            <>
                <button type="button" data-guide="x.open" data-box="20,40,140,44" onClick={() => setDialog(true)}>
                    Open the form
                </button>
                <div data-guide="x.page" data-box="500,40,300,70">
                    <input aria-label="Page field" />
                </div>
                <button type="button" onClick={() => setDialog(false)}>
                    Close from outside
                </button>
                <Modal
                    open={dialog}
                    onClose={() => setDialog(false)}
                    title="Edit details"
                    data-guide="x.dialog"
                    footer={
                        <button type="button" data-guide="x.save" data-box="700,40,120,44" onClick={() => setDialog(false)}>
                            Save
                        </button>
                    }
                >
                    <div data-guide="x.inside" data-box="100,40,300,70">
                        <input aria-label="Inside field" />
                    </div>
                </Modal>
                {playing ? (
                    <Spotlight
                        name="test-guide"
                        resolve="lazy"
                        steps={steps}
                        done={done}
                        waitMs={50}
                        counterKey={COUNTER}
                        endKey="tutorial.common.guide.end"
                        onDismiss={(outcome) => {
                            onDismiss(outcome);
                            setPlaying(false);
                        }}
                        onUnavailable={() => {}}
                    />
                ) : null}
            </>
        );
    }
    render(
        <Intl>
            <Page />
        </Intl>,
    );
    return { onDismiss };
}

const OPEN: SpotlightStep = { id: 'open', target: { guide: 'x.open' }, mode: 'action', ...copy('next') };
const INSIDE: SpotlightStep = { id: 'inside', target: { guide: 'x.inside' }, mode: 'next', ready: () => true, ...copy('title') };
const SAVE: SpotlightStep = { id: 'save', target: { guide: 'x.save' }, mode: 'action', ...copy('next') };
const ON_PAGE: SpotlightStep = { id: 'on_page', target: { guide: 'x.page' }, mode: 'next', ready: () => true, ...copy('workers') };

const crossingDialog = () => document.querySelector<HTMLElement>('[data-guide="x.dialog"]');
/** Where the walkthrough's layer is drawn. */
const layerIn = () => {
    const layer = document.querySelector('[data-spotlight]');
    if (layer === null) return null;
    return crossingDialog()?.contains(layer) ? 'dialog' : 'page';
};
/** The body's lock (a dialog's) and the root's (the walkthrough's on the page). */
const locks = () => ({ body: document.body.style.overflow, page: document.documentElement.style.overflow });
const click = (name: string) =>
    act(() => {
        fireEvent.click(screen.getByRole('button', { name }));
    });

describe('moving between the page and a dialog', () => {
    it('page → dialog → page: carries on in each, and leaves the page as it found it', async () => {
        const { onDismiss } = renderCrossing([OPEN, INSIDE, SAVE, ON_PAGE]);
        await flush();
        expect(stepOf()).toBe('open');
        expect(layerIn()).toBe('page');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        click('Open the form');
        await flush();
        expect(stepOf()).toBe('inside');
        expect(layerIn()).toBe('dialog');
        // The dialog holds the page's lock; the walkthrough holds none inside it.
        expect(locks()).toEqual({ body: 'hidden', page: '' });

        press('next');
        await flush();
        expect(stepOf()).toBe('save');
        click('Save');
        await flush();
        expect(crossingDialog()).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(stepOf()).toBe('on_page');
        expect(layerIn()).toBe('page');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        press('next');
        await flush();
        expect(onDismiss).toHaveBeenCalledWith('completed');
        expect(locks()).toEqual({ body: '', page: '' });
    });

    it('dialog → page: carries on on the page once the dialog closes, and leaves the page as it found it', async () => {
        const { onDismiss } = renderCrossing([INSIDE, SAVE, ON_PAGE], { open: true });
        await flush();
        expect(stepOf()).toBe('inside');
        expect(layerIn()).toBe('dialog');
        expect(locks()).toEqual({ body: 'hidden', page: '' });

        press('next');
        await flush();
        click('Save');
        await flush();
        expect(crossingDialog()).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(stepOf()).toBe('on_page');
        expect(layerIn()).toBe('page');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        press('next');
        await flush();
        expect(onDismiss).toHaveBeenCalledWith('completed');
        expect(locks()).toEqual({ body: '', page: '' });
    });

    it('a dialog closed under its step: carries on at the next step when that one shows on the page', async () => {
        const { onDismiss } = renderCrossing([INSIDE, ON_PAGE], { open: true });
        await flush();
        expect(stepOf()).toBe('inside');
        click('Close from outside');
        await flush();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(stepOf()).toBe('on_page');
        expect(layerIn()).toBe('page');
        expect(locks()).toEqual({ body: '', page: 'hidden' });
    });

    it('a dialog closed under its step with no next step on show: ends as skipped after the wait', async () => {
        const { onDismiss } = renderCrossing([INSIDE, SAVE], { open: true });
        await flush();
        click('Close from outside');
        await flush();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(locks()).toEqual({ body: '', page: '' });
        await flush(80);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(locks()).toEqual({ body: '', page: '' });
    });

    it('while it waits after its dialog closed, Escape ends it and is left to the page', async () => {
        const { onDismiss } = renderCrossing([INSIDE, SAVE], { open: true });
        await flush();
        click('Close from outside');
        await flush();
        let reached: KeyboardEvent | null = null;
        const listen = (event: KeyboardEvent) => {
            reached = event;
        };
        document.addEventListener('keydown', listen);
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        document.removeEventListener('keydown', listen);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(reached).not.toBeNull();
        expect((reached as unknown as KeyboardEvent).defaultPrevented).toBe(false);
    });

    it('the closing card moves to the page when the last step’s action closes the dialog', async () => {
        const { onDismiss } = renderCrossing([SAVE], {
            open: true,
            done: { titleKey: `${KEY}.intro_title`, bodyKey: `${KEY}.intro_body` },
        });
        await flush();
        click('Save');
        await flush();
        expect(crossingDialog()).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(stepOf()).toBe('done');
        expect(layerIn()).toBe('page');
        press('done');
        await flush();
        expect(onDismiss).toHaveBeenCalledWith('completed');
        expect(locks()).toEqual({ body: '', page: '' });
    });
});

describe('a host opened with the walkthrough', () => {
    it('closed before the first control shows: the play is over at once, with no outcome', async () => {
        const onUnavailable = vi.fn();
        const onDismiss = vi.fn();
        function Page() {
            const [open, setOpen] = useState(true);
            return (
                <>
                    <button type="button" onClick={() => setOpen(false)}>
                        Close the host
                    </button>
                    {open ? (
                        <div data-guide="h.host" data-box="0,0,400,400">
                            <p>Loading</p>
                        </div>
                    ) : null}
                    <Spotlight
                        name="test-guide"
                        resolve="lazy"
                        steps={[TITLE]}
                        host={{ guide: 'h.host' }}
                        waitMs={10_000}
                        counterKey={COUNTER}
                        onDismiss={onDismiss}
                        onUnavailable={onUnavailable}
                    />
                </>
            );
        }
        render(
            <Intl>
                <Page />
            </Intl>,
        );
        await flush();
        expect(onUnavailable).not.toHaveBeenCalled();
        click('Close the host');
        await flush();
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(document.querySelector('[data-spotlight]')).toBeNull();
    });
});

/**
 * A page step on a status control whose button opens a confirm (a `Modal`
 * that is not the walkthrough's); Confirm marks the status hired.
 */
function renderWithConfirm(steps: SpotlightStep[]) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    function Page() {
        const [confirming, setConfirming] = useState(false);
        const [status, setStatus] = useState('new');
        const [playing, setPlaying] = useState(true);
        return (
            <>
                <div data-guide="c.status" data-box="100,40,300,70" data-status={status}>
                    <button type="button" onClick={() => setConfirming(true)}>
                        Mark hired
                    </button>
                </div>
                <div data-guide="c.next" data-box="300,40,300,70">
                    <input aria-label="Start date" />
                </div>
                <Modal
                    open={confirming}
                    onClose={() => setConfirming(false)}
                    title="Mark as hired?"
                    footer={
                        <>
                            <button type="button" onClick={() => setConfirming(false)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setStatus('hired');
                                    setConfirming(false);
                                }}
                            >
                                Confirm
                            </button>
                        </>
                    }
                >
                    <p>The other applicants hear back.</p>
                </Modal>
                {playing ? (
                    <Spotlight
                        name="test-guide"
                        resolve="lazy"
                        steps={steps}
                        waitMs={50}
                        counterKey={COUNTER}
                        endKey="tutorial.common.guide.end"
                        onDismiss={(outcome) => {
                            onDismiss(outcome);
                            setPlaying(false);
                        }}
                        onUnavailable={() => {}}
                    />
                ) : null}
            </>
        );
    }
    render(
        <Intl>
            <Page />
        </Intl>,
    );
    return { onDismiss };
}

const STATUS: SpotlightStep = {
    id: 'status',
    target: { guide: 'c.status' },
    mode: 'auto',
    advanceWhen: (target) => target.getAttribute('data-status') === 'hired',
    ...copy('trade'),
};
const START: SpotlightStep = { id: 'start', target: { guide: 'c.next' }, mode: 'next', ready: () => true, ...copy('workers') };

const confirmDialog = () => screen.queryByRole('dialog', { name: 'Mark as hired?' });

describe('another dialog opened over the walkthrough', () => {
    it('steps aside: Tab and Escape are the dialog’s, Cancel picks up the same step, and the page lock comes out even', async () => {
        const { onDismiss } = renderWithConfirm([STATUS, START]);
        await flush();
        expect(stepOf()).toBe('status');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        click('Mark hired');
        await flush();
        const confirm = confirmDialog() as HTMLElement;
        expect(confirm).not.toBeNull();
        // Nothing of the walkthrough is drawn, and the dialog holds the page.
        expect(callout()).toBeNull();
        expect(locks()).toEqual({ body: 'hidden', page: '' });

        // Tab stays in the dialog, by the dialog's own trap.
        const last = screen.getByRole('button', { name: 'Confirm' });
        act(() => last.focus());
        act(() => {
            fireEvent.keyDown(last, { key: 'Tab' });
        });
        expect(confirm.contains(document.activeElement)).toBe(true);

        // Escape cancels the dialog, not the walkthrough.
        act(() => {
            fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
        });
        await flush();
        expect(confirmDialog()).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
        expect(stepOf()).toBe('status');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        // Picked up again, Escape is the walkthrough's.
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        await flush();
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(locks()).toEqual({ body: '', page: '' });
    });

    it('Cancel picks up the same step; Confirm, having made its condition hold, moves it on', async () => {
        renderWithConfirm([STATUS, START]);
        await flush();
        click('Mark hired');
        await flush();
        click('Cancel');
        await flush();
        expect(confirmDialog()).toBeNull();
        expect(stepOf()).toBe('status');

        click('Mark hired');
        await flush();
        click('Confirm');
        await flush();
        expect(stepOf()).toBe('start');
        expect(locks()).toEqual({ body: '', page: 'hidden' });
    });

    it('does not run out a wait while the dialog is up', async () => {
        const MARK: SpotlightStep = { id: 'mark', target: { guide: 'c.status' }, mode: 'action', ...copy('next') };
        const LATER: SpotlightStep = { ...START, id: 'later', target: { guide: 'c.later' } };
        const { onDismiss } = renderWithConfirm([MARK, LATER]);
        await flush();
        // The click completes the step and opens the confirm; the next
        // step's control is not there, and its wait (50 ms) is held.
        click('Mark hired');
        await flush(120);
        expect(confirmDialog()).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
        click('Cancel');
        await flush();
        await flush(120);
        // With the dialog gone the wait ran out: the last step never showed.
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });
});

/** `document.elementsFromPoint` over the `data-box` boxes: fixed chrome on top, the innermost element first. */
function stubHitTesting(): () => void {
    const at = (x: number, y: number): Element[] => {
        const hits = Array.from(document.querySelectorAll<HTMLElement>('[data-box]')).filter((element) => {
            const r = element.getBoundingClientRect();
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        });
        const fixed = (element: Element) => Number(element.closest('[data-fixed]') !== null);
        return hits.sort((a, b) => fixed(b) - fixed(a) || (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    };
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: at });
    const scroll = vi.spyOn(window, 'scrollBy').mockImplementation(((x: number | ScrollToOptions, y?: number) => {
        pageScroll += typeof x === 'number' ? (y ?? 0) : (x.top ?? 0);
    }) as typeof window.scrollBy);
    return () => {
        scroll.mockRestore();
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
        document.documentElement.style.removeProperty('--jale-tab-bar-offset');
    };
}

/** A field near the bottom of an 800px viewport, under a fixed 64px bar; and a tab in that bar. */
function renderUnderBar(steps: SpotlightStep[], resolve: 'lazy' | 'start' = 'lazy') {
    // The page first: a tour cuts its steps to what is on screen as it starts.
    render(
        <>
            <div data-guide="r.field" data-box="760,40,300,40">
                <input aria-label="Near the bottom" />
            </div>
            <nav data-fixed="" style={{ position: 'fixed' }} data-box="736,0,1280,64">
                <button type="button" data-tour="tab.home" data-box="736,0,200,64">
                    Home
                </button>
            </nav>
        </>,
    );
    render(
        <Intl>
            <Spotlight
                name="test-guide"
                resolve={resolve}
                steps={steps}
                waitMs={50}
                counterKey={COUNTER}
                onDismiss={() => {}}
                onUnavailable={() => {}}
            />
        </Intl>,
    );
}

const FIELD: SpotlightStep = { id: 'field', target: { guide: 'r.field' }, mode: 'next', ready: () => true, ...copy('title') };

/** What is on top at the middle of `element`, as the page draws it. */
const onTopAtMiddle = (element: Element) => {
    const r = element.getBoundingClientRect();
    return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0] ?? null;
};

describe('a control on the page, under the phone tab bar', () => {
    it('is scrolled clear of the bar the page says it has', async () => {
        const restore = stubHitTesting();
        document.documentElement.style.setProperty('--jale-tab-bar-offset', '64px');
        renderUnderBar([FIELD]);
        await flush();
        const field = document.querySelector('[data-guide="r.field"]') as HTMLElement;
        expect(stepOf()).toBe('field');
        expect(field.getBoundingClientRect().bottom).toBeLessThanOrEqual(800 - 64);
        expect(field.contains(onTopAtMiddle(field))).toBe(true);
        restore();
    });

    it('is scrolled clear of a fixed bar found on top of it, with no offset given', async () => {
        const restore = stubHitTesting();
        renderUnderBar([FIELD]);
        await flush();
        const field = document.querySelector('[data-guide="r.field"]') as HTMLElement;
        expect(field.contains(onTopAtMiddle(field))).toBe(true);
        expect(field.getBoundingClientRect().bottom).toBeLessThanOrEqual(736);
        restore();
    });

    it('leaves a control in the bar itself where it is (the app tour’s tab-bar stops)', async () => {
        const restore = stubHitTesting();
        const scrollBy = vi.mocked(window.scrollBy);
        renderUnderBar([{ id: 'home', target: { tour: 'tab.home' }, titleKey: `${KEY}.intro_title`, bodyKey: `${KEY}.intro_body` }], 'start');
        await flush();
        expect(stepOf()).toBe('home');
        expect(scrollBy).not.toHaveBeenCalled();
        restore();
    });
});

describe('a control the page moves after it was scrolled to', () => {
    it('is scrolled back into view when the page grows above it', async () => {
        const restore = stubHitTesting();
        document.documentElement.style.setProperty('--jale-tab-bar-offset', '64px');
        renderUnderBar([FIELD]);
        await flush();
        const field = document.querySelector('[data-guide="r.field"]') as HTMLElement;
        expect(field.getBoundingClientRect().bottom).toBeLessThanOrEqual(736);
        // A refetch draws more above it: it is now below the viewport.
        act(() => {
            field.setAttribute('data-box', `${1100 + pageScroll},40,300,40`);
        });
        expect(field.getBoundingClientRect().top).toBeGreaterThan(800);
        await flush(50);
        const rect = field.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(736);
        expect(field.contains(onTopAtMiddle(field))).toBe(true);
        restore();
    });
});

describe('a control whose list opens under the phone tab bar', () => {
    it('is scrolled with its list above the bar, so an option can be tapped', async () => {
        const restore = stubHitTesting();
        document.documentElement.style.setProperty('--jale-tab-bar-offset', '64px');
        const CITY_FIELD: SpotlightStep = { id: 'city', target: { guide: 'r.city' }, mode: 'auto', advanceWhen: () => false, ...copy('city') };
        render(
            <>
                <div data-guide="r.city" data-box="680,40,300,40">
                    <input aria-label="City" role="combobox" aria-expanded="false" aria-controls="city-options" />
                </div>
                <nav data-fixed="" style={{ position: 'fixed' }} data-box="736,0,1280,64">
                    <button type="button" data-box="736,0,200,64">
                        Home
                    </button>
                </nav>
            </>,
        );
        render(
            <Intl>
                <Spotlight
                    name="test-guide"
                    resolve="lazy"
                    steps={[CITY_FIELD]}
                    waitMs={50}
                    counterKey={COUNTER}
                    onDismiss={() => {}}
                    onUnavailable={() => {}}
                />
            </Intl>,
        );
        await flush();
        expect(stepOf()).toBe('city');
        expect(vi.mocked(window.scrollBy)).not.toHaveBeenCalled();

        // The person types: the suggestions open below the field, the first one under the bar.
        act(() => {
            const list = document.createElement('ul');
            list.id = 'city-options';
            list.setAttribute('role', 'listbox');
            list.setAttribute('data-box', `${724 + pageScroll},40,300,200`);
            const option = document.createElement('li');
            option.setAttribute('role', 'option');
            option.setAttribute('data-box', `${724 + pageScroll},40,300,40`);
            option.textContent = 'El Paso, TX';
            list.append(option);
            document.querySelector('[data-guide="r.city"]')?.append(list);
            const input = screen.getByRole('combobox', { name: 'City' });
            input.setAttribute('aria-expanded', 'true');
            input.setAttribute('aria-controls', 'city-options');
        });
        await flush(50);
        const option = screen.getByRole('option', { name: 'El Paso, TX' });
        const list = screen.getByRole('listbox');
        expect(list.getBoundingClientRect().bottom).toBeLessThanOrEqual(736);
        expect(option.contains(onTopAtMiddle(option))).toBe(true);
        restore();
    });
});

describe('a control taller than the page shows', () => {
    it('leaves the page free to scroll on its step, the ring following, and the next step holds the page again', async () => {
        const restore = stubHitTesting();
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
        const LONG: SpotlightStep = { id: 'long', target: { guide: 'r.long' }, mode: 'next', ready: () => true, ...copy('title') };
        const SHORT: SpotlightStep = { id: 'short', target: { guide: 'r.short' }, mode: 'next', ready: () => true, ...copy('workers') };
        render(
            <>
                <div data-guide="r.long" data-box="100,40,300,1200">
                    <input aria-label="Work history" />
                </div>
                <div data-guide="r.short" data-box="1400,40,300,60">
                    <input aria-label="Phone" />
                </div>
            </>,
        );
        render(
            <Intl>
                <Spotlight
                    name="test-guide"
                    resolve="lazy"
                    steps={[LONG, SHORT]}
                    waitMs={50}
                    counterKey={COUNTER}
                    onDismiss={() => {}}
                    onUnavailable={() => {}}
                />
            </Intl>,
        );
        await flush();
        expect(stepOf()).toBe('long');
        // 1200px in an 844px viewport: the person scrolls it, so the page is not held.
        expect(document.documentElement.style.overflow).toBe('');
        const ring = () => {
            const style = (document.querySelector('[data-spotlight-ring]') as HTMLElement).style;
            return { top: Number.parseFloat(style.top), bottom: Number.parseFloat(style.top) + Number.parseFloat(style.height) };
        };
        // The ring keeps to the part in view: from the control's top to the viewport's bottom.
        expect(ring()).toEqual({ top: 94, bottom: 844 });

        // The person scrolls on, to the control's end: the ring follows it.
        act(() => {
            pageScroll = 806;
            window.dispatchEvent(new Event('scroll'));
        });
        await flush();
        expect(ring()).toEqual({ top: 0, bottom: 1306 - 806 });
        // With room beside the part in view, the callout is there, off the ring.
        const card = callout() as HTMLElement;
        const at = { top: Number.parseFloat(card.style.top), left: Number.parseFloat(card.style.left) };
        const ringBox = document.querySelector('[data-spotlight-ring]') as HTMLElement;
        const ringRight = Number.parseFloat(ringBox.style.left) + Number.parseFloat(ringBox.style.width);
        expect(at.top >= ring().bottom || at.left >= ringRight || at.top + 160 <= ring().top).toBe(true);
        // Nothing scrolled it back on them.
        expect(vi.mocked(window.scrollBy)).not.toHaveBeenCalled();

        press('next');
        await flush();
        expect(stepOf()).toBe('short');
        expect(document.documentElement.style.overflow).toBe('hidden');
        restore();
    });
});

describe('ending on the page it started on', () => {
    afterEach(() => {
        window.history.replaceState(null, '', '/');
    });

    it('a change of page ends it at once, as skipped', async () => {
        const { onDismiss, show } = renderGuide([TITLE, TRADE], {}, { waitMs: 10_000 });
        await flush();
        expect(stepOf()).toBe('title');
        // A link: the address changes and the new page draws.
        act(() => {
            window.history.pushState(null, '', '/elsewhere');
        });
        show({ fields: { trade: true } });
        await flush();
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('a last step passed over because its control never came ends it as skipped, with no closing card', async () => {
        const MISSING: SpotlightStep = { ...TRADE, id: 'missing', target: { guide: 't.missing' } };
        const { onDismiss } = renderGuide([TITLE, MISSING], {}, {
            waitMs: 30,
            done: { titleKey: `${KEY}.intro_title`, bodyKey: `${KEY}.intro_body` },
        });
        await flush();
        type('#title', 'Framer');
        press('next');
        await flush(60);
        expect(stepOf()).toBeNull();
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });
});
