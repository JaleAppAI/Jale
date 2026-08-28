import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { OnboardingState } from '@/lib/api/worker';

/**
 * Screens are rendered against the REAL catalogues through the REAL provider,
 * not a `useTranslations` stub. Two reasons: the copy carries em dashes and
 * curly quotes that a hand-typed test literal gets subtly wrong, and a key
 * that only exists in English fails the Spanish pass here instead of shipping.
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
    // `rerender` from RTL replaces the WHOLE tree, provider included, so it has
    // to be re-wrapped or the second render loses its translations.
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

/** `{name}` substitution only — enough for the counters and confirm prompt. */
export function interpolate(raw: string, values: Record<string, string | number>): string {
    return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

export function onboardingState(overrides: Partial<OnboardingState> = {}): OnboardingState {
    return {
        lifecycle: 'onboarding',
        run: { id: 'run-1', stepKey: 'legal.review', lockVersion: 1, preferredLanguage: 'en', workflowVersion: 2 },
        profile: {
            fullName: null,
            location: null,
            trade: null,
            yearsExperience: null,
            hasTransportation: null,
            availability: null,
        },
        trust: { questions: [], answers: [] },
        pendingLocationConfirm: null,
        extraction: null,
        ...overrides,
    };
}

export const THREE_QUESTIONS = [
    { index: 1, q_en: 'What do you do on a typical day?', q_es: '¿Qué haces en un día típico?' },
    { index: 2, q_en: 'What tools do you know well?', q_es: '¿Qué herramientas sabes usar bien?' },
    { index: 3, q_en: 'Tell me about a job you are proud of.', q_es: 'Cuéntame de un trabajo del que estés orgulloso.' },
];
