import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/**
 * Employer component suites render against the REAL catalogues through the
 * REAL provider, not a `useTranslations` stub: the copy carries em dashes and
 * curly quotes a hand-typed literal gets subtly wrong, and a key that only
 * exists in English fails the Spanish pass here instead of shipping.
 *
 * A deliberate sibling of `components/worker/onboarding/__tests__/render-intl.tsx`
 * rather than a shared move to `src/test/`: the sprint-23 worker lane owns
 * that move, and two lanes creating the same new file is a merge conflict for
 * twenty lines of helper.
 *
 * Not a `.test.` file, so vitest collects it as a helper rather than a suite.
 */

export const catalogues = { en, es } as const;
export type TestLocale = keyof typeof catalogues;

export function renderIntl(ui: ReactElement, locale: TestLocale = 'en') {
    const wrap = (node: ReactElement) => (
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={() => {}}>
            {node}
        </NextIntlClientProvider>
    );
    const result = render(wrap(ui));
    // RTL's `rerender` replaces the WHOLE tree, provider included, so it has to
    // be re-wrapped or the second render loses its translations.
    return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

type MessageNode = string | { [key: string]: MessageNode };

/** Resolve a dotted path against a catalogue. Throws if the key is missing. */
export function message(path: string, locale: TestLocale = 'en'): string {
    let node: MessageNode = catalogues[locale] as MessageNode;
    for (const segment of path.split('.')) {
        if (typeof node === 'string' || !(segment in node)) {
            throw new Error(`No ${locale}.json message at "${path}"`);
        }
        node = node[segment];
    }
    if (typeof node !== 'string') throw new Error(`"${path}" is not a leaf message`);
    return node;
}

/** `{name}` substitution only -- enough for the counters and tip sentences. */
export function interpolate(raw: string, values: Record<string, string | number>): string {
    return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
