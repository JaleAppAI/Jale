import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS } from '@/lib/api/tutorials';

/**
 * The Help center's copy (K1-v2): `tutorial.help_center` in both catalogues,
 * right after `tutorial.common`, the role-specific strings under `employer`
 * (usted) and `worker` (tú), and a description and length for every guide.
 */

type MessageNode = string | { [key: string]: MessageNode };

function lookup(catalogue: unknown, path: string): unknown {
    let node = catalogue as MessageNode | undefined;
    for (const segment of path.split('.')) {
        if (node === undefined || typeof node === 'string') return undefined;
        node = node[segment];
    }
    return node;
}

const SHARED_KEYS = [
    'title',
    'subtitle',
    'helper_off',
    'tour_again',
    'tour_again_sub',
    'guides',
    'off_tag',
    'play',
    'play_label',
    'show_again',
    'show_again_label',
    'mute',
];

const ROLE_KEYS = ['switch', 'helper_on', 'muted_title', 'muted_empty', 'muted_toast', 'save_failed'];

const DESCRIPTIONS: Record<string, [string, string]> = {
    employer_welcome: ['From posting a job to hiring, in five steps.', 'De publicar un empleo a contratar, en cinco pasos.'],
    employer_post_job: ['The three steps and what you must fill in.', 'Los tres pasos y lo que debe llenar.'],
    employer_applicants: ['Trust scores, statuses and how to hire.', 'Puntajes de confianza, estados y cómo contratar.'],
    employer_messages: ['How your messages reach workers on WhatsApp.', 'Cómo les llegan sus mensajes a los trabajadores por WhatsApp.'],
    worker_onboarding: ['The 7 short steps and the three questions.', 'Los 7 pasos cortos y las tres preguntas.'],
    worker_apply: ['Applying, documents and what happens next.', 'Cómo postularte, los documentos y qué sigue.'],
    worker_details: ['What to do when an employer wants to hire you.', 'Qué hacer cuando un empleador quiere contratarte.'],
    worker_profile: ['What employers see, and your documents.', 'Lo que ven los empleadores y tus documentos.'],
};

describe('tutorial.help_center', () => {
    it.each([['en', en], ['es', es]] as const)('sits right after tutorial.common in %s', (_locale, catalogue) => {
        const keys = Object.keys(catalogue.tutorial);
        expect(keys.indexOf('help_center')).toBe(keys.indexOf('common') + 1);
    });

    it.each([['en', en], ['es', es]] as const)('has every shared and role string in %s', (_locale, catalogue) => {
        for (const key of SHARED_KEYS) {
            expect(lookup(catalogue, `tutorial.help_center.${key}`), key).toBeTypeOf('string');
        }
        for (const role of ['employer', 'worker']) {
            for (const key of ROLE_KEYS) {
                expect(lookup(catalogue, `tutorial.help_center.${role}.${key}`), `${role}.${key}`).toBeTypeOf('string');
            }
        }
    });

    it('reads the same in English for both roles', () => {
        for (const key of ROLE_KEYS) {
            expect(lookup(en, `tutorial.help_center.employer.${key}`), key).toBeTypeOf('string');
            expect(lookup(en, `tutorial.help_center.employer.${key}`), key).toBe(lookup(en, `tutorial.help_center.worker.${key}`));
        }
    });

    it('speaks usted to employers and tú to workers in Spanish', () => {
        expect(lookup(es, 'tutorial.help_center.employer.muted_toast')).toBe('Guía apagada. Puede volver a activarla en Ayuda.');
        expect(lookup(es, 'tutorial.help_center.worker.muted_toast')).toBe('Guía apagada. Puedes volver a activarla en Ayuda.');
        expect(lookup(es, 'tutorial.help_center.employer.save_failed')).toBe('No se pudo guardar. Inténtelo de nuevo.');
        expect(lookup(es, 'tutorial.help_center.worker.save_failed')).toBe('No se pudo guardar. Inténtalo de nuevo.');
        expect(lookup(es, 'tutorial.help_center.employer.muted_title')).toBe('Guías que apagó');
        expect(lookup(es, 'tutorial.help_center.worker.muted_title')).toBe('Guías que apagaste');
    });
});

describe('each guide’s description and length', () => {
    it.each([...EMPLOYER_TUTORIAL_IDS, ...WORKER_TUTORIAL_IDS])('%s has both, in both languages', (id) => {
        const [english, spanish] = DESCRIPTIONS[id];
        expect(lookup(en, `tutorial.${id}.description`)).toBe(english);
        expect(lookup(es, `tutorial.${id}.description`)).toBe(spanish);
        expect(lookup(en, `tutorial.${id}.duration`)).toBe('1 min');
        expect(lookup(es, `tutorial.${id}.duration`)).toBe('1 min');
    });
});
