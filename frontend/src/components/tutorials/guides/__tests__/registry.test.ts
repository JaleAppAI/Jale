import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS } from '@/lib/api/tutorials';
import { GUIDES, getGuide } from '../registry';

/*
 * The step-by-step guides: one entry per tutorial id (null keeps the slides
 * only), every key a guide names present in both catalogues, and the
 * post-job guide in the wizard's real order, over its real `post.*` hooks.
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
    'tutorial.common.guide.employer.start',
    'tutorial.common.guide.worker.start',
    'tutorial.common.guide.self',
    'tutorial.common.guide.end',
    'tutorial.help_center.mute',
];

describe('guides registry', () => {
    it('has an entry for every tutorial id', () => {
        expect(Object.keys(GUIDES).sort()).toEqual([...EMPLOYER_TUTORIAL_IDS, ...WORKER_TUTORIAL_IDS].sort());
    });

    it.each([['en', en], ['es', es]] as const)('names only keys that exist in %s', (_locale, catalogue) => {
        for (const key of SHARED_KEYS) expect(lookup(catalogue, key), key).toBeTypeOf('string');
        for (const [id, guide] of Object.entries(GUIDES)) {
            if (guide === null) continue;
            const keys = [guide.intro.titleKey, guide.intro.bodyKey, guide.intro.eyebrowKey, guide.counterKey, guide.done?.titleKey, guide.done?.bodyKey];
            for (const step of guide.steps) keys.push(step.titleKey, step.bodyKey, step.waitKey);
            for (const key of keys.filter((k): k is string => k !== undefined)) {
                expect(lookup(catalogue, key), `${id}: ${key}`).toBeTypeOf('string');
            }
        }
    });

    it('walks the post-job wizard in the order it shows its fields', () => {
        const guide = getGuide('employer_post_job');
        expect(guide).not.toBeNull();
        expect(guide?.steps.map((step) => [step.id, step.mode, step.target])).toEqual([
            ['title', 'next', { guide: 'post.title' }],
            ['city', 'auto', { guide: 'post.city' }],
            ['trade', 'auto', { guide: 'post.trade' }],
            ['trade_other', 'next', { guide: 'post.trade_other' }],
            ['next', 'action', { guide: 'post.next' }],
            ['workers', 'next', { guide: 'post.workers' }],
        ]);
        // Only the Other box is conditional; the wizard's Next completes on the screen changing.
        expect(guide?.steps.filter((step) => step.when).map((step) => step.id)).toEqual(['trade_other']);
        expect(guide?.steps.find((step) => step.id === 'next')?.advanceWhen).toBeTypeOf('function');
    });

    it('speaks usted to the employer, and says Tap or Click by the pointer', () => {
        const steps = es.tutorial.employer_post_job.guide.steps;
        expect(steps.title.body).toContain('{input, select, touch {Toque} other {Haga clic en}}');
        expect(steps.trade_other.body).toContain('Escriba');
        expect(es.tutorial.common.guide.employer.start).toBe('Guíeme');
        expect(es.tutorial.common.guide.worker.start).toBe('Guíame');
        expect(en.tutorial.employer_post_job.guide.steps.next.wait).toBe('{input, select, touch {Tap} other {Click}} Next to continue.');
    });
});
