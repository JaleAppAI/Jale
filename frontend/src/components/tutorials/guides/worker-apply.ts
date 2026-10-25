import { guideTarget } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import { hasText, valueOf } from './dom';
import type { WalkthroughGuide } from './types';

/**
 * W2's step-by-step guide: applying to a job. The job page asks for it with
 * `runWithHost` where applying starts: in the profile gate, when Apply (or an
 * `?apply=1` arrival) opens it for an incomplete profile, carrying on through
 * "Save and apply" into the apply screen; otherwise in the apply screen as it
 * opens. It replaces the slides that used to open over the job page; Help
 * keeps the slides as the overview.
 *
 * Steps, as the screens show them (`apply.gate*` hooks in
 * `ProfileCompleteModal`, `apply.*` in `ApplyFlow` and the job page):
 *  - the gate, when it is up: the name (only while empty), skills, the
 *    availability (it starts empty when the profile has none), the location,
 *    the optional years, then "Save and apply", done when the gate gives way
 *    to the apply screen (a save that fails keeps the gate, and the step);
 *  - after the gate: the profile is saved, and nothing is sent yet;
 *  - each employer question (up to 10), Next once it holds 1 to 1000
 *    characters (trimmed), as the screen's own Send rule; or, for a job with
 *    no questions, a word that there is nothing to answer;
 *  - "documents come later";
 *  - Send application: completes when the screen gives way (a failed send
 *    keeps the screen, and the step, up);
 *  - then whichever the job page shows: applied (the status), or closed (the
 *    reason beside the greyed Apply, when the job closed meanwhile), or, for a
 *    worker who went "Back to the job" before sending, the way back in.
 * A gate closed without saving leaves no step that applies, so the guide
 * ends there. A closed or filled job, or one already applied to, never opens
 * the gate or the screen, so the guide never starts there.
 *
 * While the gate is up, the apply screen's steps are counted ahead (the job
 * page says how many questions it will ask, `data-questions` on Apply), so
 * the counter's total does not end on "Save and apply". Those steps are only
 * reached once the gate has given way to the screen.
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

function gateUp(): boolean {
    return guideTarget('apply.gate') !== null;
}

function screenUp(): boolean {
    return guideTarget('apply.screen') !== null;
}

function applied(): boolean {
    return guideTarget('apply.applied') !== null;
}

/** How many questions the apply screen will ask, as the job page says (read from the gate). */
function questionsAhead(): number {
    return Number(guideTarget('apply.button')?.getAttribute('data-questions') ?? 0) || 0;
}

function answered(control: Element): boolean {
    const length = control.querySelector('textarea')?.value.trim().length ?? 0;
    return length >= 1 && length <= MAX_ANSWER;
}

function gateStep(
    id: string,
    field: string,
    { wait = true, ...extra }: Partial<SpotlightStep> & { wait?: boolean } = {},
): SpotlightStep {
    return {
        id,
        target: { guide: `apply.gate.${field}` },
        mode: 'next',
        when: gateUp,
        ready: hasText,
        ...copy(id, { wait }),
        ...extra,
    };
}

function questionStep(number: number): SpotlightStep {
    return {
        id: `answer_${number}`,
        target: { guide: `apply.answer.${number}` },
        mode: 'next',
        when: () => (screenUp() ? guideTarget(`apply.answer.${number}`) !== null : gateUp() && number <= questionsAhead()),
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
        // The profile gate.
        gateStep('gate_name', 'name', { when: () => gateUp() && (valueOf('apply.gate.name') ?? '').trim() === '' }),
        gateStep('gate_skills', 'skills', {
            // What Save will count: one comma-separated item at least.
            ready: (control) =>
                (control instanceof HTMLInputElement ? control.value : '').split(',').some((item) => item.trim() !== ''),
        }),
        gateStep('gate_availability', 'availability'),
        gateStep('gate_location', 'location'),
        gateStep('gate_years', 'years', { ready: () => true, wait: false }),
        {
            id: 'gate_save',
            target: { guide: 'apply.gate.save' },
            mode: 'action',
            placement: 'top',
            when: gateUp,
            // The gate giving way to the apply screen, not the click: a save
            // that fails keeps the gate up, with its error, and this step.
            advanceWhen: () => !gateUp() && screenUp(),
            ...copy('gate_save'),
        },

        // The apply screen.
        {
            id: 'from_gate',
            target: { guide: 'apply.intro' },
            mode: 'next',
            when: () => (guideTarget('apply.intro')?.hasAttribute('data-from-gate') ?? false) || gateUp(),
            ...copy('from_gate', { wait: false }),
        },
        ...Array.from({ length: MAX_QUESTIONS }, (_, index) => questionStep(index + 1)),
        {
            id: 'no_questions',
            target: { guide: 'apply.intro' },
            mode: 'next',
            when: () => (screenUp() ? guideTarget('apply.answer.1') === null : gateUp() && questionsAhead() === 0),
            ...copy('no_questions', { wait: false }),
        },
        {
            id: 'later',
            target: { guide: 'apply.later' },
            mode: 'next',
            when: () => screenUp() || gateUp(),
            ...copy('later', { wait: false }),
        },
        {
            id: 'send',
            target: { guide: 'apply.send' },
            mode: 'action',
            placement: 'top',
            when: () => screenUp() || gateUp(),
            // The screen giving way to the job page, not the click: a send that
            // fails keeps the screen up, with its error, and this step.
            advanceWhen: () => !screenUp(),
            ...copy('send'),
        },
        {
            id: 'sent',
            target: { guide: 'apply.applied' },
            mode: 'next',
            // Counted while the gate or the screen is up (it is what Send leads
            // to); reached only once the screen has gone, when it needs the
            // Applied status.
            when: () => applied() || screenUp() || gateUp(),
            ...copy('sent', { wait: false }),
        },
        {
            id: 'closed',
            target: { guide: 'apply.closed' },
            mode: 'next',
            when: () => !screenUp() && !gateUp() && !applied() && guideTarget('apply.closed') !== null,
            ...copy('closed', { wait: false }),
        },
        // "Back to the job" before sending: what was typed is kept on this page.
        {
            id: 'left',
            target: { guide: 'apply.button' },
            mode: 'action',
            placement: 'top',
            when: () =>
                !screenUp() && !gateUp() && !applied() && (guideTarget('apply.button')?.hasAttribute('data-left') ?? false),
            ...copy('left'),
        },
    ],
};

export default guide;
