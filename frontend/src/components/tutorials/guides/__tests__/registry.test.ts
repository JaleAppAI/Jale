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

    it('walks the post-job wizard in the order it shows its fields, then its other places', () => {
        const guide = getGuide('employer_post_job');
        expect(guide).not.toBeNull();
        expect(guide?.steps.map((step) => [step.id, step.mode, step.target])).toEqual([
            // Screen 1
            ['template', 'next', { guide: 'post.template' }],
            ['title', 'next', { guide: 'post.title' }],
            ['city_check', 'next', { guide: 'post.city' }],
            ['city', 'auto', { guide: 'post.city' }],
            ['trade', 'auto', { guide: 'post.trade' }],
            ['trade_other', 'next', { guide: 'post.trade_other' }],
            ['next', 'action', { guide: 'post.next' }],
            // Screen 2
            ['pay', 'next', { guide: 'post.pay' }],
            ['workers', 'next', { guide: 'post.workers' }],
            ['shifts', 'next', { guide: 'post.shifts' }],
            ['times', 'next', { guide: 'post.times' }],
            ['certifications', 'next', { guide: 'post.certifications' }],
            ['next_details', 'action', { guide: 'post.next' }],
            // Screen 3, Post and what Post can answer
            ['questions', 'next', { guide: 'post.questions' }],
            ['requirements', 'next', { guide: 'post.requirements' }],
            ['template_save', 'next', { guide: 'post.template_save' }],
            ['template_name', 'next', { guide: 'post.template_name' }],
            ['submit', 'action', { guide: 'post.submit' }],
            ['post_error', 'action', { guide: 'post.submit' }],
            ['job_limit', 'next', { guide: 'post.job_limit' }],
            ['template_taken', 'next', { guide: 'post.template_save' }],
            ['template_limit', 'action', { guide: 'post.template_limit' }],
            ['post_again', 'action', { guide: 'post.submit' }],
            // The posted screen
            ['template_not_saved', 'next', { guide: 'post.template_not_saved' }],
            ['share', 'next', { guide: 'post.share' }],
            ['done', 'action', { guide: 'post.back' }],
            // The plan-limit dialog, the edit dialog, the template editor
            ['limit', 'next', { guide: 'limit.body' }],
            ['limit_actions', 'action', { guide: 'limit.actions' }],
            ['edit_form', 'next', { guide: 'edit.title' }],
            ['edit_locked', 'next', { guide: 'edit.questions' }],
            ['edit_workers', 'next', { guide: 'edit.workers' }],
            ['edit_save', 'action', { guide: 'edit.save' }],
            ['tpl_name', 'next', { guide: 'tpl.name' }],
            ['tpl_form', 'next', { guide: 'tpl.title' }],
            ['tpl_save', 'action', { guide: 'tpl.save' }],
        ]);
        // Every step names the place it belongs to; the wizard's Next steps complete on the screen changing.
        expect(guide?.steps.every((step) => typeof step.when === 'function')).toBe(true);
        expect(guide?.steps.find((step) => step.id === 'next')?.advanceWhen).toBeTypeOf('function');
        expect(guide?.steps.find((step) => step.id === 'next_details')?.advanceWhen).toBeTypeOf('function');
        // It runs in the wizard, opened with it.
        expect(guide?.host).toEqual({ guide: 'post.wizard' });
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
