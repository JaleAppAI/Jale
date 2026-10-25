import type { ReactElement } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialId, TutorialOutcome } from '@/lib/api/tutorials';
import type { PlayMode } from '@/lib/tutorials/progress';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { ToastProvider } from '@/components/ui/toast';
import GuideHost from '../../GuideHost';

/*
 * The employer guides' test kit: a real page part (the wizard, a dialog, a
 * page) with the real guide drawn over it by the real `GuideHost`, the way
 * the progress store draws it. jsdom does no layout, so every element reports
 * one box (on screen) and a zero-sized rect; the guide's own conditions read
 * the page, never layout.
 *
 * Not a `.test.` file: vitest collects it as a helper.
 */

export const catalogues = { en, es } as const;
export type Locale = keyof typeof catalogues;

type MessageNode = string | { [key: string]: MessageNode };

/** A catalogue message by dotted path (throws when missing). */
export function message(path: string, locale: Locale = 'en'): string {
    let node: MessageNode = catalogues[locale] as MessageNode;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) throw new Error(`No ${locale} message at ${path}`);
        node = node[segment];
    }
    if (typeof node !== 'string') throw new Error(`${path} is not a leaf`);
    return node;
}

/** Everything on screen, nothing measured: see the note above. */
export function fakeLayout() {
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
        return (this.isConnected && !this.closest('[hidden]') ? [{}] : []) as unknown as DOMRectList;
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
}

export function renderWithGuide(
    ui: ReactElement,
    { id, mode = 'auto', locale = 'en' }: { id: TutorialId; mode?: PlayMode; locale?: Locale },
) {
    const onDismiss = vi.fn<(outcome: TutorialOutcome) => void>();
    const onUnavailable = vi.fn();
    const onMute = vi.fn(async () => true);
    const view = (guideOn: boolean, node: ReactElement) => (
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
            <OverlayPresenceProvider>
                <ToastProvider>
                    {node}
                    {guideOn ? (
                        <GuideHost id={id} mode={mode} onMute={onMute} onDismiss={onDismiss} onUnavailable={onUnavailable} />
                    ) : null}
                </ToastProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
    // The host first, then the guide: as `runWithHost` and a page's own
    // `maybeAutoOpen` both do.
    const result = render(view(false, ui));
    result.rerender(view(true, ui));
    return {
        ...result,
        onDismiss,
        onUnavailable,
        onMute,
        rerenderHost: (next: ReactElement) => result.rerender(view(true, next)),
    };
}

/** Lets the page-watching observers and short waits run. */
export async function flush(ms = 0) {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

/** The guide's callout now. */
export function callout(): HTMLElement | null {
    const layer = document.querySelector('[data-spotlight]');
    const dialogs = layer ? Array.from(layer.querySelectorAll<HTMLElement>('[role="dialog"]')) : [];
    return dialogs.at(-1) ?? null;
}

/** The step on screen (`intro`, a step id, or `done`), or null with no guide drawn. */
export function currentStep(): string | null {
    return callout()?.getAttribute('data-step') ?? null;
}

/** The callout's counter line ("Posting a job · 2 of 9"). */
export function counter(): string | null {
    const box = callout();
    if (!box || box.getAttribute('data-step') === 'intro') return null;
    return box.querySelector('p')?.textContent ?? null;
}

export function action(name: string): HTMLButtonElement | null {
    return callout()?.querySelector<HTMLButtonElement>(`[data-spotlight-action="${name}"]`) ?? null;
}

/** Presses one of the callout's buttons (`start`, `next`, `end`, `back`, ...). */
export async function press(name: string) {
    const button = action(name);
    if (!button) throw new Error(`no "${name}" in the callout at step ${currentStep()}`);
    act(() => {
        fireEvent.click(button);
    });
    await flush();
}

/** Waits (a few short turns) for the guide to reach `id`. */
export async function reach(id: string, turns = 40) {
    for (let turn = 0; turn < turns && currentStep() !== id; turn += 1) await flush(5);
    if (currentStep() !== id) throw new Error(`guide at "${currentStep()}", expected "${id}"`);
}

export const mark = (name: string) => document.querySelector<HTMLElement>(`[data-guide="${name}"]`);
