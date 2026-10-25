import { guideTarget } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import type { WalkthroughGuide } from './types';

/**
 * W2's step-by-step guide: applying to a job, played INSIDE the apply screen
 * as it opens (the job page's `openApplyFlow` asks for it with
 * `runWithHost`): from Apply, from the profile gate's "Save and apply", and
 * from an `?apply=1` arrival alike. It replaces the slides that used to open
 * over the job page; Help keeps the slides as the overview.
 *
 * Steps, as the screen shows them (`apply.*` hooks in `ApplyFlow` and the job
 * page):
 *  - after the profile gate: the profile is saved, and nothing is sent yet;
 *  - each employer question (up to 10), Next once it holds 1 to 1000
 *    characters (trimmed), as the screen's own Send rule; or, for a job with
 *    no questions, a word that there is nothing to answer;
 *  - "documents come later";
 *  - Send application: completes when the screen gives way (a failed send
 *    keeps the screen, and the step, up);
 *  - then whichever the job page shows: applied (the status), or closed (the
 *    reason beside the greyed Apply, when the job closed meanwhile), or, for a
 *    worker who went "Back to the job" before sending, the way back in.
 * A closed or filled job, or one already applied to, never opens the apply
 * screen, so the guide never starts there.
 */

const KEY = 'tutorial.worker_apply.guide';

/** The employer asks at most this many questions. */
const MAX_QUESTIONS = 10;

/** The longest answer the screen sends, trimmed (`MAX_PROMPT_ANSWER_CHARS`). */
const MAX_ANSWER = 1000;

/** A step's copy; `wait: false` for a step that never waits (it has no wait line). */
function copy(id: string, { wait = true }: { wait?: boolean } = {}) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        ...(wait ? { waitKey: `${KEY}.steps.${id}.wait` } : {}),
    };
}

function screenUp(): boolean {
    return guideTarget('apply.screen') !== null;
}

function applied(): boolean {
    return guideTarget('apply.applied') !== null;
}

function answered(control: Element): boolean {
    const length = control.querySelector('textarea')?.value.trim().length ?? 0;
    return length >= 1 && length <= MAX_ANSWER;
}

function questionStep(number: number): SpotlightStep {
    return {
        id: `answer_${number}`,
        target: { guide: `apply.answer.${number}` },
        mode: 'next',
        when: () => screenUp() && guideTarget(`apply.answer.${number}`) !== null,
        ready: answered,
        ...copy(number === 1 ? 'answer_first' : 'answer_more'),
    };
}

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.worker_apply.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [
        {
            id: 'from_gate',
            target: { guide: 'apply.intro' },
            mode: 'next',
            when: () => guideTarget('apply.intro')?.hasAttribute('data-from-gate') ?? false,
            ...copy('from_gate', { wait: false }),
        },
        ...Array.from({ length: MAX_QUESTIONS }, (_, index) => questionStep(index + 1)),
        {
            id: 'no_questions',
            target: { guide: 'apply.intro' },
            mode: 'next',
            when: () => screenUp() && guideTarget('apply.answer.1') === null,
            ...copy('no_questions', { wait: false }),
        },
        { id: 'later', target: { guide: 'apply.later' }, mode: 'next', when: screenUp, ...copy('later', { wait: false }) },
        {
            id: 'send',
            target: { guide: 'apply.send' },
            mode: 'action',
            placement: 'top',
            when: screenUp,
            // The screen giving way to the job page, not the click: a send that
            // fails keeps the screen up, with its error, and this step.
            advanceWhen: () => !screenUp(),
            ...copy('send'),
        },
        { id: 'sent', target: { guide: 'apply.applied' }, mode: 'next', when: applied, ...copy('sent', { wait: false }) },
        {
            id: 'closed',
            target: { guide: 'apply.closed' },
            mode: 'next',
            when: () => !screenUp() && !applied() && guideTarget('apply.closed') !== null,
            ...copy('closed', { wait: false }),
        },
        // "Back to the job" before sending: what was typed is kept on this page.
        {
            id: 'left',
            target: { guide: 'apply.button' },
            mode: 'action',
            placement: 'top',
            when: () => !screenUp() && !applied() && guideTarget('apply.closed') === null,
            ...copy('left'),
        },
    ],
};

export default guide;
