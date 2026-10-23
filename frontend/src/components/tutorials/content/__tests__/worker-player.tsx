import type { ReactNode } from 'react';
import { act, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { tutorialCalls } from '@/lib/tutorials/__tests__/harness';

/**
 * Helpers for the suites that drive a worker host page with the REAL
 * tutorial: the providers as the app layout mounts them (R1), the real
 * progress store, player, registry and content. Not a `.test.` file, so
 * vitest collects it as a helper rather than a suite.
 *
 * Each suite still mocks `@/contexts/AuthContext`, `@/i18n/navigation` and
 * `@/lib/api` itself (mocks are hoisted per file), pointing them at
 * `@/lib/tutorials/__tests__/harness`.
 */

const catalogues = { en, es } as const;

export function workerProviders(locale: 'en' | 'es' = 'en') {
    return function Providers({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
                <OverlayPresenceProvider>
                    <TutorialProgressProvider>{children}</TutorialProgressProvider>
                </OverlayPresenceProvider>
            </NextIntlClientProvider>
        );
    };
}

/** Two separate acts: the second commits whatever the first one's promises woke up. */
export async function settle() {
    for (let turn = 0; turn < 2; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

export const dialogCount = () => document.querySelectorAll('[role="dialog"]').length;

/** The tutorial records written so far, as the bodies that were POSTed. */
export const recordsPosted = () =>
    tutorialCalls()
        .filter(([method]) => method === 'POST')
        .map(([, , body]) => body);

/**
 * Presses the dialog's primary button until it reads `last`, then returns it.
 * Call it outside `act`: each press is its own act, so the slide turns.
 */
export function walkToLast(dialog: HTMLElement, next: string, last: string): HTMLElement {
    for (let guard = 0; guard < 10; guard += 1) {
        const done = within(dialog).queryByRole('button', { name: last });
        if (done) return done;
        act(() => within(dialog).getByRole('button', { name: next }).click());
    }
    throw new Error(`never reached "${last}"`);
}

/**
 * jsdom lays nothing out, so the modal's focus trap would find nothing
 * focusable; every element reports one box. And the player's own chunk is
 * fetched up front, as the provider's preload does in the app, so "nothing
 * opened" is never passed by a chunk still on its way.
 */
export async function preparePlayer() {
    const rects = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockImplementation(() => [{}] as unknown as DOMRectList);
    await import('@/components/tutorials/TutorialHost');
    return () => rects.mockRestore();
}
