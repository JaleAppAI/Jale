import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { TutorialOutcome } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { Modal } from '@/components/ui/modal';
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

function boxOf(element: Element): { top: number; left: number; width: number; height: number } {
    const raw = element.getAttribute('data-box');
    if (raw) {
        const [top, left, width, height] = raw.split(',').map(Number);
        return { top, left, width, height };
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
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

    it('ends as skipped when the dialog is closed under it', async () => {
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
        expect(onDismiss).toHaveBeenCalledWith('skipped');
    });

    it('the intro sits inside the dialog too', async () => {
        renderInDialog([TITLE], {}, { intro: INTRO });
        await flush();
        expect(stepOf()).toBe('intro');
        expect(panel()?.contains(callout())).toBe(true);
        expect(document.activeElement).toBe(action('start'));
    });
});
