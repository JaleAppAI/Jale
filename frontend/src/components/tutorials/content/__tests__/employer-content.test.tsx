import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { expectNoRawMessageKeys } from '@/components/worker/onboarding/__tests__/render-intl';
import { SceneStage } from '@/components/tutorials/scene';
import { TutorialPlayer } from '@/components/tutorials/TutorialPlayer';
import type { TutorialDefinition, TutorialSceneProps } from '@/lib/tutorials/types';
import employerWelcome from '../employer-welcome';
import employerPostJob from '../employer-post-job';
import employerApplicants from '../employer-applicants';
import employerMessages from '../employer-messages';

/*
 * The four employer tutorials (E1–E4) as the boards draw them: their slides,
 * their copy in both languages, and scenes that show the finished picture
 * when still and move otherwise. Every scene renders with no host values,
 * because a replay from Help may pass none.
 */

type Locale = 'en' | 'es';
type MessageNode = string | { [key: string]: MessageNode };
const CATALOGUES: Record<Locale, MessageNode> = { en: en as MessageNode, es: es as MessageNode };

function lookup(path: string, locale: Locale): MessageNode | undefined {
    let node: MessageNode | undefined = CATALOGUES[locale];
    for (const segment of path.split('.')) {
        if (node === undefined || typeof node === 'string') return undefined;
        node = node[segment];
    }
    return node;
}

function leaf(path: string, locale: Locale): string {
    const node = lookup(path, locale);
    if (typeof node !== 'string') throw new Error(`No ${locale} message at "${path}"`);
    return node;
}

const EMPLOYER: ReadonlyArray<[string, TutorialDefinition]> = [
    ['employer_welcome', employerWelcome],
    ['employer_post_job', employerPostJob],
    ['employer_applicants', employerApplicants],
    ['employer_messages', employerMessages],
];

/** The boards' eyebrows and slide titles, in order. */
const BOARD_TITLES: Record<string, Record<Locale, { title: string; slides: string[] }>> = {
    employer_welcome: {
        en: {
            title: 'How Jale works',
            slides: [
                'Post a job in 3 steps',
                'Share your job link',
                'Workers apply on WhatsApp or the web',
                'Review and message',
                'Request details, then hire',
            ],
        },
        es: {
            title: 'Cómo funciona Jale',
            slides: [
                'Publique un empleo en 3 pasos',
                'Comparta el enlace de su empleo',
                'Los trabajadores se postulan por WhatsApp o en la web',
                'Revise y escriba',
                'Solicite datos y luego contrate',
            ],
        },
    },
    employer_post_job: {
        en: {
            title: 'Posting a job',
            slides: ['Three short steps', 'Pick the city from the list', 'Choose the shifts', 'Questions come in two parts'],
        },
        es: {
            title: 'Publicar un empleo',
            slides: ['Tres pasos cortos', 'Elija la ciudad de la lista', 'Elija los turnos', 'Las preguntas tienen dos partes'],
        },
    },
    employer_applicants: {
        en: {
            title: 'Your applicants',
            slides: ['What you see first', 'Statuses are for you', 'Request details to hire', 'Hired, then start details'],
        },
        es: {
            title: 'Sus postulantes',
            slides: [
                'Lo que ve primero',
                'Los estados son para usted',
                'Solicite datos para contratar',
                'Contratado y luego los datos de inicio',
            ],
        },
    },
    employer_messages: {
        en: {
            title: 'Messages',
            slides: ['Messages travel over WhatsApp', 'Your first message is an invitation', 'Then you can write freely'],
        },
        es: {
            title: 'Mensajes',
            slides: [
                'Los mensajes viajan por WhatsApp',
                'Su primer mensaje es una invitación',
                'Después puede escribir libremente',
            ],
        },
    },
};

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

/** Like a browser: keyframe offsets in 0..1 and non-decreasing, or it throws. */
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

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as { animate?: unknown }).animate;
});

/** Renders one scene on its stage and collects every message the catalogue could not answer. */
function renderScene(
    Scene: TutorialDefinition['slides'][number]['Scene'],
    { locale, still, vars }: { locale: Locale; still: boolean; vars?: TutorialSceneProps['vars'] },
) {
    const errors: string[] = [];
    const view = render(
        <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale] as Record<string, unknown>} onError={(error) => errors.push(error.message)}>
            <SceneStage tone="blue" still={still}>
                <Scene still={still} vars={vars} />
            </SceneStage>
        </NextIntlClientProvider>,
    );
    return { ...view, errors };
}

describe.each(EMPLOYER)('%s content', (id, definition) => {
    it('keeps the contract shape the registry and Help rely on', () => {
        expect(definition.id).toBe(id);
        expect(definition.role).toBe('employer');
        expect(definition.namespace).toBe(`tutorial.${id}`);
        expect(definition.titleKey).toBe('title');
        expect(definition.slides.length).toBe(BOARD_TITLES[id].en.slides.length);
        expect(definition.slides.length).toBeGreaterThanOrEqual(3);
        expect(definition.slides.length).toBeLessThanOrEqual(5);
    });

    it.each(['en', 'es'] as const)('carries the board copy in %s, with no placeholder in any title or body', (locale) => {
        const board = BOARD_TITLES[id][locale];
        expect(leaf(`${definition.namespace}.${definition.titleKey}`, locale)).toBe(board.title);
        expect(definition.slides.map((slide) => leaf(`${definition.namespace}.${slide.titleKey}`, locale))).toEqual(board.slides);
        for (const slide of definition.slides) {
            const title = leaf(`${definition.namespace}.${slide.titleKey}`, locale);
            const body = leaf(`${definition.namespace}.${slide.bodyKey}`, locale);
            expect(body.length, `${slide.id} body`).toBeGreaterThan(20);
            // A replay from Help may pass no values, so a `{placeholder}` here would show raw.
            expect(title, `${slide.id} title`).not.toMatch(/[{}]/);
            expect(body, `${slide.id} body`).not.toMatch(/[{}]/);
        }
    });

    it('has no last-button label of its own, so the last button reads "Got it"', () => {
        expect(lookup(`${definition.namespace}.cta_last`, 'en')).toBeUndefined();
        expect(lookup(`${definition.namespace}.cta_last`, 'es')).toBeUndefined();
    });

    describe.each(['en', 'es'] as const)('in %s', (locale) => {
        it('draws every scene still, with no host values: the final frame, no motion, every string found', () => {
            const animate = stubAnimate();
            stubReducedMotion(false);
            for (const slide of definition.slides) {
                const { container, errors, unmount } = renderScene(slide.Scene, { locale, still: true });
                expect(errors, slide.id).toEqual([]);
                expect(container.textContent?.trim().length, slide.id).toBeGreaterThan(0);
                expect(container.textContent, slide.id).not.toMatch(/[{}]/);
                expectNoRawMessageKeys(container);
                // Decoration only: the slide's title and body carry the meaning.
                expect(container.querySelector('button, a, input, [tabindex]'), slide.id).toBeNull();
                unmount();
            }
            expect(animate).not.toHaveBeenCalled();
        });

        it('moves every scene on a moving stage', () => {
            stubReducedMotion(false);
            for (const slide of definition.slides) {
                const animate = stubAnimate();
                const { errors, unmount } = renderScene(slide.Scene, { locale, still: false });
                expect(errors, slide.id).toEqual([]);
                expect(animate.mock.calls.length, slide.id).toBeGreaterThan(0);
                unmount();
            }
        });
    });
});

describe('the employer tutorial copy in Spanish', () => {
    /** The same word in both languages, on purpose: "Web", and each guide's length in Help ("1 min"). */
    const SAME_IN_BOTH = new Set([
        'tutorial.employer_welcome.scenes.web',
        'tutorial.employer_welcome.duration',
        'tutorial.employer_post_job.duration',
        'tutorial.employer_applicants.duration',
        'tutorial.employer_messages.duration',
    ]);

    function leaves(node: MessageNode, path: string): Array<[string, string]> {
        if (typeof node === 'string') return [[path, node]];
        return Object.entries(node).flatMap(([key, child]) => leaves(child, `${path}.${key}`));
    }

    it('translates every employer tutorial string rather than repeating the English', () => {
        const repeated: string[] = [];
        for (const [, definition] of EMPLOYER) {
            const english = lookup(definition.namespace, 'en');
            expect(english, definition.namespace).toBeTypeOf('object');
            for (const [path, value] of leaves(english as MessageNode, definition.namespace)) {
                const spanish = lookup(path, 'es');
                expect(spanish, path).toBeTypeOf('string');
                if (spanish === value && !SAME_IN_BOTH.has(path)) repeated.push(path);
            }
        }
        expect(repeated).toEqual([]);
    });
});

describe('the welcome tour’s plan line', () => {
    const hire = employerWelcome.slides[employerWelcome.slides.length - 1];

    it('reads the limit the host passes, with no plan name', () => {
        stubReducedMotion(false);
        const english = renderScene(hire.Scene, { locale: 'en', still: true, vars: { activeJobLimit: 7 } });
        expect(english.container.textContent).toContain('Your plan: up to 7 active jobs');
        expect(english.container.textContent).not.toMatch(/free|starter|pro\b/i);
        english.unmount();

        const spanish = renderScene(hire.Scene, { locale: 'es', still: true, vars: { activeJobLimit: 7 } });
        expect(spanish.container.textContent).toContain('Su plan: hasta 7 empleos activos');
        spanish.unmount();
    });

    it('speaks of one job and of none in plain words', () => {
        stubReducedMotion(false);
        const one = renderScene(hire.Scene, { locale: 'en', still: true, vars: { activeJobLimit: 1 } });
        expect(one.container.textContent).toContain('Your plan: up to 1 active job');
        expect(one.container.textContent).not.toContain('1 active jobs');
        one.unmount();

        const oneEs = renderScene(hire.Scene, { locale: 'es', still: true, vars: { activeJobLimit: 1 } });
        expect(oneEs.container.textContent).toContain('Su plan: hasta 1 empleo activo');
        expect(oneEs.container.textContent).not.toContain('1 empleo activos');
        oneEs.unmount();

        const none = renderScene(hire.Scene, { locale: 'en', still: true, vars: { activeJobLimit: 0 } });
        expect(none.container.textContent).toContain('Your plan does not include active jobs');
        none.unmount();
    });

    it('is left out when no limit was passed, as on a replay from Help', () => {
        stubReducedMotion(false);
        const cases: Array<TutorialSceneProps['vars']> = [undefined, {}, { activeJobLimit: 'many' }, { activeJobLimit: -1 }, { activeJobLimit: 2.5 }];
        for (const vars of cases) {
            const { container, errors, unmount } = renderScene(hire.Scene, { locale: 'en', still: true, vars });
            expect(errors).toEqual([]);
            expect(container.textContent).not.toMatch(/your plan|active job|\{limit/i);
            unmount();
        }
    });

    it('appears on no other slide', () => {
        stubReducedMotion(false);
        for (const slide of employerWelcome.slides.slice(0, -1)) {
            const { container, unmount } = renderScene(slide.Scene, { locale: 'en', still: true, vars: { activeJobLimit: 7 } });
            expect(container.textContent, slide.id).not.toMatch(/your plan/i);
            unmount();
        }
    });
});

describe('the employer tutorials in the real player', () => {
    it.each(EMPLOYER.flatMap(([id, definition]) => (['en', 'es'] as const).map((locale) => [id, locale, definition] as const)))(
        '%s plays every slide in %s with no host values and ends on "Got it"',
        (id, locale, definition) => {
            stubReducedMotion(true);
            const onDismiss = vi.fn();
            const errors: string[] = [];
            render(
                <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale] as Record<string, unknown>} onError={(error) => errors.push(error.message)}>
                    <TutorialPlayer definition={definition} onDismiss={onDismiss} />
                </NextIntlClientProvider>,
            );
            const board = BOARD_TITLES[id][locale];
            expect(screen.getByRole('dialog', { name: board.title })).toBeTruthy();
            const next = leaf('tutorial.common.next', locale);
            const gotIt = leaf('tutorial.common.got_it', locale);
            board.slides.forEach((title, index) => {
                expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(title);
                expectNoRawMessageKeys();
                const last = index === board.slides.length - 1;
                act(() => {
                    fireEvent.click(screen.getByRole('button', { name: last ? gotIt : next }));
                });
            });
            expect(onDismiss).toHaveBeenCalledWith('completed');
            expect(errors).toEqual([]);
        },
    );
});
