// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { SceneStage } from '@/components/tutorials/scene';
import { expectNoRawMessageKeys } from '@/components/worker/onboarding/__tests__/render-intl';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import workerOnboarding from '../worker-onboarding';
import workerApply from '../worker-apply';
import workerDetails from '../worker-details';
import workerProfile from '../worker-profile';

/*
 * The four worker tutorials (W1-W4), as the boards draw them: their slides,
 * their copy in both languages, and scenes that are pure decoration and show
 * their finished picture when nothing moves.
 */

const catalogues = { en, es } as const;
type Locale = keyof typeof catalogues;

function lookup(locale: Locale, path: string): unknown {
    return path.split('.').reduce<unknown>(
        (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
        catalogues[locale],
    );
}

function text(locale: Locale, definition: TutorialDefinition, key: string): string {
    const value = lookup(locale, `${definition.namespace}.${key}`);
    if (typeof value !== 'string') throw new Error(`missing ${locale} ${definition.namespace}.${key}`);
    return value;
}

const WORKER: ReadonlyArray<[string, TutorialDefinition, number]> = [
    ['W1 worker_onboarding', workerOnboarding, 4],
    ['W2 worker_apply', workerApply, 4],
    ['W3 worker_details', workerDetails, 3],
    ['W4 worker_profile', workerProfile, 3],
];

/** Like a browser, refuses keyframes whose offsets fall outside 0..1 or run backwards. */
function stubAnimate() {
    const animate = vi.fn(function (this: Element, keyframes: Keyframe[]) {
        let previous = 0;
        for (const frame of keyframes) {
            if (frame.offset === undefined || frame.offset === null) continue;
            if (frame.offset < 0 || frame.offset > 1 || frame.offset < previous) {
                throw new TypeError('Offsets must be in [0, 1] and non-decreasing');
            }
            previous = frame.offset;
        }
        return { cancel: vi.fn() } as unknown as Animation;
    });
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    return animate;
}

afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
});

function renderScene(definition: TutorialDefinition, index: number, locale: Locale, still: boolean) {
    const Scene = definition.slides[index].Scene;
    return render(
        <NextIntlClientProvider locale={locale} messages={catalogues[locale]}>
            <SceneStage tone="teal" still={still}>
                <Scene still={still} />
            </SceneStage>
        </NextIntlClientProvider>,
    );
}

describe('worker tutorial content', () => {
    it.each(WORKER)('%s has the board’s slides, each with a title and a body in both languages', (_, definition, slides) => {
        expect(definition.role).toBe('worker');
        expect(definition.slides).toHaveLength(slides);
        expect(new Set(definition.slides.map((slide) => slide.id)).size).toBe(slides);
        for (const locale of ['en', 'es'] as const) {
            expect(text(locale, definition, definition.titleKey)).not.toBe('');
            for (const slide of definition.slides) {
                expect(text(locale, definition, slide.titleKey)).not.toBe('');
                expect(text(locale, definition, slide.bodyKey)).not.toBe('');
            }
        }
    });

    it('names each tutorial with its board eyebrow, the title Help lists', () => {
        expect(WORKER.map(([, definition]) => text('en', definition, 'title'))).toEqual([
            'Before you start',
            'How applying works',
            'Details requested',
            'Your profile',
        ]);
        expect(WORKER.map(([, definition]) => text('es', definition, 'title'))).toEqual([
            'Antes de empezar',
            'Cómo postularte',
            'Te pidieron tus datos',
            'Tu perfil',
        ]);
    });

    it('ends W1 on "Let’s start" and W3 on "Start"; W2 and W4 keep the common "Got it"', () => {
        expect(text('en', workerOnboarding, 'cta_last')).toBe('Let’s start');
        expect(text('es', workerOnboarding, 'cta_last')).toBe('Empecemos');
        expect(text('en', workerDetails, 'cta_last')).toBe('Start');
        expect(text('es', workerDetails, 'cta_last')).toBe('Empezar');
        expect(lookup('en', `${workerApply.namespace}.cta_last`)).toBeUndefined();
        expect(lookup('es', `${workerApply.namespace}.cta_last`)).toBeUndefined();
        expect(lookup('en', `${workerProfile.namespace}.cta_last`)).toBeUndefined();
        expect(lookup('es', `${workerProfile.namespace}.cta_last`)).toBeUndefined();
    });

    it('says W1 is about 2 minutes in 7 short steps, and draws all 7', () => {
        const first = workerOnboarding.slides[0];
        expect(text('en', workerOnboarding, first.titleKey)).toBe('About 2 minutes');
        expect(text('en', workerOnboarding, first.bodyKey)).toMatch(/^7 short steps/);
        expect(text('es', workerOnboarding, first.bodyKey)).toMatch(/^7 pasos cortos/);

        const { container } = renderScene(workerOnboarding, 0, 'en', true);
        expect(container.querySelectorAll('[data-scene-segment]')).toHaveLength(7);
    });

    it('keeps slide titles and bodies free of placeholders, so a Help replay with no values reads whole', () => {
        for (const [, definition] of WORKER) {
            for (const locale of ['en', 'es'] as const) {
                for (const slide of definition.slides) {
                    expect(text(locale, definition, slide.titleKey)).not.toMatch(/[{}]/);
                    expect(text(locale, definition, slide.bodyKey)).not.toMatch(/[{}]/);
                }
            }
        }
    });
});

describe('worker tutorial scenes', () => {
    const SCENES = WORKER.flatMap(([name, definition]) =>
        definition.slides.map((slide, index) => [`${name} · ${slide.id}`, definition, index] as const),
    );

    it.each(SCENES)('%s renders its copy in both languages and hides itself from assistive tech', (_, definition, index) => {
        for (const locale of ['en', 'es'] as const) {
            const { container, unmount } = renderScene(definition, index, locale, true);
            expectNoRawMessageKeys(container);
            expect(container.textContent?.trim()).not.toBe('');
            // Decoration only: nothing in a scene can be reached or pressed.
            expect(container.querySelector('button, a, input, textarea, select, [tabindex]')).toBeNull();
            const visible = Array.from(container.querySelectorAll('*')).filter(
                (element) => !element.closest('[aria-hidden="true"]'),
            );
            expect(visible.filter((element) => element.textContent?.trim())).toEqual([]);
            unmount();
        }
    });

    it.each(SCENES)('%s stands still on a still stage and moves otherwise', (_, definition, index) => {
        const animate = stubAnimate();
        const still = renderScene(definition, index, 'en', true);
        expect(animate).not.toHaveBeenCalled();
        still.unmount();

        renderScene(definition, index, 'en', false);
        expect(animate).toHaveBeenCalled();
    });
});
