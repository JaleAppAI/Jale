import { locationDatasetFailed } from '@/lib/location-search';
import { guideTarget } from '../spotlight/steps';
import type { SpotlightStep } from '../spotlight/steps';
import { fieldIn, hasText, isPicked, valueOf } from './dom';
import type { WalkthroughGuide } from './types';

/**
 * E2's step-by-step guide: posting a job. One list of steps for the four
 * places it plays, each step kept to its own place by its `when`:
 *
 *  - THE WIZARD (`PostJobModal`, opened by `PostJobContext` with
 *    `runWithHost`): every screen in the order it shows its fields, then
 *    Post, what can go wrong at Post, and the posted screen. The marks are
 *    `data-guide="post.*"`; `post.form` carries the screen as `data-step`.
 *  - THE PLAN-LIMIT DIALOG, shown instead of the wizard when the plan has no
 *    free slot (`limit.*`). Only on a replay or an "every time" play.
 *  - THE EDIT DIALOG on a job's page (`edit.*`), one form, some of it locked
 *    once someone has applied. "Every time" plays only.
 *  - THE TEMPLATE EDITOR on the templates page (`tpl.*`). "Every time" plays only.
 *
 * The wizard is the default place: its steps apply whenever none of the other
 * three is up, so a guide started with the wizard waits for the wizard's
 * first field like before.
 *
 * Each step that the wizard could refuse at Next is a `next` step whose
 * `ready` holds only once the wizard would accept it (both shift times or
 * neither, no empty question, a template name when the box is ticked), so a
 * guided Next goes through. Post can still be refused by the server: the
 * steps after it each apply to one answer (an error, the plan limit, a
 * template name taken or the template cap) and end on posting again.
 *
 * Copy names the labels on screen: the wizard's own "Post Job" button, not
 * the dashboard's "Post a job".
 */

const KEY = 'tutorial.employer_post_job.guide';

/** The steps that say what they wait for (a step that is always ready shows no wait line). */
const WAITS: ReadonlySet<string> = new Set(['city', 'city_check', 'edit_workers', 'next', 'next_details', 'pay', 'post_again', 'post_error', 'questions', 'submit', 'template_limit', 'template_name', 'template_taken', 'times', 'title', 'tpl_name', 'trade', 'trade_other', 'workers']);

function keys(id: string) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        ...(WAITS.has(id) ? { waitKey: `${KEY}.steps.${id}.wait` } : {}),
    };
}

const up = (name: string) => guideTarget(name) !== null;

/** The other three places the guide plays. */
const inLimitDialog = () => up('limit.dialog');
const inEdit = () => up('edit.dialog');
const inTemplateEditor = () => up('tpl.dialog');
/** The wizard: the default, whenever none of the other places is up. */
const inWizard = () => !inLimitDialog() && !inEdit() && !inTemplateEditor();

/** The wizard's screen, 1 to 3, as its form says; null once posted. */
function wizardScreen(): string | null {
    return guideTarget('post.form')?.getAttribute('data-step') ?? null;
}

const posted = () => up('post.posted');

/** Post was pressed and refused at least once in this draft. */
const postRefused = () => guideTarget('post.form')?.getAttribute('data-post-refused') === 'true';

/** No field inside `control` is marked invalid (a live pay range line, say). */
const noneInvalid = (control: Element) => control.querySelector('[aria-invalid="true"]') === null;

/** Both shift times filled, or neither: the wizard refuses one on its own. */
function shiftTimesPaired(control: Element): boolean {
    const times = Array.from(control.querySelectorAll<HTMLInputElement>('input[type="time"]'));
    const filled = times.filter((input) => input.value !== '').length;
    return filled === 0 || filled === times.length;
}

/** Every quick question has text: an empty one stops Post. */
function noEmptyQuestion(control: Element): boolean {
    return Array.from(control.querySelectorAll<HTMLTextAreaElement>('textarea')).every(
        (field) => field.disabled || field.value.trim() !== '',
    );
}

/** What Post did: posted, or one of the answers the steps after it explain. */
const postAnswered = () =>
    posted() || up('post.error') || up('post.job_limit') || up('post.template_taken') || up('post.template_limit');

function workersReady(control: Element): boolean {
    const field = fieldIn(control);
    const raw = field?.value.trim() ?? '';
    const floor = field instanceof HTMLInputElement && field.min ? Number(field.min) : 1;
    return raw !== '' && Number.isInteger(Number(raw)) && Number(raw) >= Math.max(1, floor);
}

const WIZARD: readonly SpotlightStep[] = [
    // Screen 1: Job basics.
    {
        id: 'template',
        target: { guide: 'post.template' },
        // The picker is there only when the employer has saved templates.
        when: () => inWizard() && up('post.template'),
        mode: 'next',
        ...keys('template'),
    },
    {
        id: 'title',
        target: { guide: 'post.title' },
        when: inWizard,
        mode: 'next',
        ready: hasText,
        ...keys('title'),
    },
    {
        id: 'city_check',
        target: { guide: 'post.city' },
        // A template brought its city: the wizard asks to check it.
        when: () => inWizard() && up('post.city_check'),
        mode: 'next',
        ready: (control) => isPicked(control) || (locationDatasetFailed() && hasText(control)),
        ...keys('city_check'),
    },
    {
        id: 'city',
        target: { guide: 'post.city' },
        when: () => inWizard() && !up('post.city_check'),
        mode: 'auto',
        // Above the field, so the suggestion list opening below it stays clear.
        placement: 'top',
        advanceWhen: isPicked,
        ready: (control) => isPicked(control) || (locationDatasetFailed() && hasText(control)),
        ...keys('city'),
    },
    {
        id: 'trade',
        target: { guide: 'post.trade' },
        when: inWizard,
        mode: 'auto',
        advanceWhen: hasText,
        ...keys('trade'),
    },
    {
        id: 'trade_other',
        target: { guide: 'post.trade_other' },
        when: () => inWizard() && valueOf('post.trade') === 'other',
        mode: 'next',
        ready: hasText,
        ...keys('trade_other'),
    },
    {
        id: 'next',
        target: { guide: 'post.next' },
        when: inWizard,
        mode: 'action',
        placement: 'top',
        advanceWhen: () => wizardScreen() === '2',
        ...keys('next'),
    },
    // Screen 2: Pay and schedule.
    {
        id: 'pay',
        target: { guide: 'post.pay' },
        when: inWizard,
        mode: 'next',
        ready: noneInvalid,
        ...keys('pay'),
    },
    {
        id: 'workers',
        target: { guide: 'post.workers' },
        when: inWizard,
        mode: 'next',
        ready: workersReady,
        ...keys('workers'),
    },
    {
        id: 'shifts',
        target: { guide: 'post.shifts' },
        when: inWizard,
        mode: 'next',
        ...keys('shifts'),
    },
    {
        id: 'times',
        target: { guide: 'post.times' },
        when: inWizard,
        mode: 'next',
        ready: shiftTimesPaired,
        ...keys('times'),
    },
    {
        id: 'certifications',
        target: { guide: 'post.certifications' },
        when: inWizard,
        mode: 'next',
        placement: 'top',
        ...keys('certifications'),
    },
    {
        id: 'next_details',
        target: { guide: 'post.next' },
        when: inWizard,
        mode: 'action',
        placement: 'top',
        advanceWhen: () => wizardScreen() === '3',
        ...keys('next_details'),
    },
    // Screen 3: What applicants must provide.
    {
        id: 'questions',
        target: { guide: 'post.questions' },
        when: inWizard,
        mode: 'next',
        ready: noEmptyQuestion,
        ...keys('questions'),
    },
    {
        id: 'requirements',
        target: { guide: 'post.requirements' },
        when: inWizard,
        mode: 'next',
        ...keys('requirements'),
    },
    {
        id: 'template_save',
        target: { guide: 'post.template_save' },
        when: inWizard,
        mode: 'next',
        ...keys('template_save'),
    },
    {
        id: 'template_name',
        target: { guide: 'post.template_name' },
        // Only once "Save as template" is ticked: then a name is required.
        when: () => inWizard() && up('post.template_name'),
        mode: 'next',
        ready: hasText,
        ...keys('template_name'),
    },
    {
        id: 'submit',
        target: { guide: 'post.submit' },
        // Not once posted: the posted screen replaces this button in the
        // same change that completes the step, and a step whose control has
        // gone is waited for, not passed, unless it no longer applies.
        when: () => inWizard() && !posted(),
        mode: 'action',
        placement: 'top',
        advanceWhen: postAnswered,
        ...keys('submit'),
    },
    // What Post can answer besides "posted".
    {
        id: 'post_error',
        target: { guide: 'post.submit' },
        when: () => inWizard() && up('post.error') && !posted(),
        mode: 'action',
        placement: 'top',
        advanceWhen: () => posted() || up('post.job_limit'),
        ...keys('post_error'),
    },
    {
        id: 'job_limit',
        target: { guide: 'post.job_limit' },
        when: () => inWizard() && up('post.job_limit'),
        mode: 'next',
        ...keys('job_limit'),
    },
    {
        id: 'template_taken',
        target: { guide: 'post.template_save' },
        when: () => inWizard() && up('post.template_taken'),
        mode: 'next',
        // The line goes once the name changes (or the box is unticked).
        ready: () => !up('post.template_taken') && (!up('post.template_name') || hasText(guideTarget('post.template_name') as Element)),
        ...keys('template_taken'),
    },
    {
        id: 'template_limit',
        target: { guide: 'post.template_limit' },
        when: () => inWizard() && up('post.template_limit'),
        mode: 'action',
        advanceWhen: () => posted() || up('post.error') || up('post.job_limit'),
        ...keys('template_limit'),
    },
    {
        id: 'post_again',
        target: { guide: 'post.submit' },
        // After Post was refused (the form says so), on the last screen, not
        // posted, and not stopped by a limit Post cannot get past. Never
        // before the first press, so it is not counted on the way there.
        when: () =>
            inWizard() &&
            wizardScreen() === '3' &&
            postRefused() &&
            !posted() &&
            !up('post.job_limit') &&
            !up('post.template_limit'),
        mode: 'action',
        placement: 'top',
        advanceWhen: () => posted() || up('post.job_limit'),
        ...keys('post_again'),
    },
    // The posted screen.
    {
        id: 'template_not_saved',
        target: { guide: 'post.template_not_saved' },
        when: () => inWizard() && up('post.template_not_saved'),
        mode: 'next',
        ...keys('template_not_saved'),
    },
    {
        id: 'share',
        target: { guide: 'post.share' },
        when: () => inWizard() && !up('post.job_limit'),
        mode: 'next',
        ...keys('share'),
    },
    {
        id: 'done',
        target: { guide: 'post.back' },
        when: () => inWizard() && !up('post.job_limit'),
        mode: 'next',
        placement: 'top',
        ...keys('done'),
    },
];

const LIMIT_DIALOG: readonly SpotlightStep[] = [
    {
        id: 'limit',
        target: { guide: 'limit.body' },
        when: inLimitDialog,
        mode: 'next',
        ...keys('limit'),
    },
    {
        id: 'limit_actions',
        target: { guide: 'limit.actions' },
        when: inLimitDialog,
        mode: 'next',
        placement: 'top',
        ...keys('limit_actions'),
    },
];

const EDIT: readonly SpotlightStep[] = [
    {
        id: 'edit_form',
        target: { guide: 'edit.title' },
        when: inEdit,
        mode: 'next',
        ...keys('edit_form'),
    },
    {
        id: 'edit_locked',
        target: { guide: 'edit.questions' },
        // Once someone has applied (the form marks its questions locked).
        when: () => inEdit() && guideTarget('edit.questions')?.hasAttribute('data-locked') === true,
        mode: 'next',
        ...keys('edit_locked'),
    },
    {
        id: 'edit_workers',
        target: { guide: 'edit.workers' },
        // Only with workers already hired: the box will not go below them.
        when: () => {
            const field = guideTarget('edit.workers')?.querySelector('input');
            return inEdit() && !!field && Number(field.min) > 1;
        },
        mode: 'next',
        ready: workersReady,
        ...keys('edit_workers'),
    },
    {
        id: 'edit_save',
        target: { guide: 'edit.save' },
        when: inEdit,
        mode: 'next',
        placement: 'top',
        ...keys('edit_save'),
    },
];

const TEMPLATE_EDITOR: readonly SpotlightStep[] = [
    {
        id: 'tpl_name',
        target: { guide: 'tpl.name' },
        when: inTemplateEditor,
        mode: 'next',
        ready: hasText,
        ...keys('tpl_name'),
    },
    {
        id: 'tpl_form',
        target: { guide: 'tpl.title' },
        when: inTemplateEditor,
        mode: 'next',
        ...keys('tpl_form'),
    },
    {
        id: 'tpl_save',
        target: { guide: 'tpl.save' },
        when: inTemplateEditor,
        mode: 'next',
        placement: 'top',
        ...keys('tpl_save'),
    },
];

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.employer_post_job.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [...WIZARD, ...LIMIT_DIALOG, ...EDIT, ...TEMPLATE_EDITOR],
};

export default guide;
