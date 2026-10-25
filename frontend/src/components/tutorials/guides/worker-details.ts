import { MAX_PROMPT_ANSWER_CHARS } from '@/lib/application-requirements-flow';
import type { SpotlightStep } from '../spotlight/steps';
import { guideTarget } from '../spotlight/steps';
import type { WalkthroughGuide } from './types';

/**
 * W3's step-by-step guide: an employer asked for the worker's details, on
 * `/worker/applications/[id]`. The page plays it once, when the flow first
 * shows (the prompt top-up or the stepper); Help's Play keeps the slides.
 *
 * The flow is one panel at a time, and `details.flow` carries which one as
 * `data-panel` (`topup`, `details`, `documents`, `review`, `complete`,
 * `terminal`). Every step asks for its own panel in `when`, so a step whose
 * panel has gone (the worker saved and moved on, or opened the page on a later
 * step) is passed over at once, and an `action` step on a panel's button
 * moves on when the next panel replaces it.
 *
 *  - Top-up (only for employer questions left from applying on WhatsApp): the
 *    answer boxes, Next once every one holds 1 to 1000 characters; then
 *    "Save and continue", done when the stepper shows.
 *  - The overview: the bar and the three steps. Its Next waits for the saved
 *    files to load, so the document steps after it read the vault's real state.
 *  - Details: one step per question the job asks, in the order the form
 *    shows them, from the row's own `data-required` / `data-complete`: a
 *    required one is ready once complete, an optional one always (Skip is
 *    offered). Then "Save and continue", done when Documents shows.
 *  - Documents & certifications: the vault retry when the saved files could
 *    not be read; the notices for documents that cannot be uploaded here; one
 *    step per document (already saved: nothing to do; not saved: Upload, and
 *    the step moves on once the file is saved); the legacy certification row;
 *    the named certifications, ready once every required one lets Continue
 *    through; then "Continue", done when Check & finish shows.
 *  - Check & finish: the summary; the way back when something is still
 *    missing (the guide ends there: it cannot walk the earlier steps again);
 *    Finish, done when the completion screen shows; then the way back to
 *    the applications.
 */

const KEY = 'tutorial.worker_details.guide';

function copy(id: string, wait = true) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        ...(wait ? { waitKey: `${KEY}.steps.${id}.wait` } : {}),
    };
}

/** The panel the flow shows now, or null when the flow is not on screen. */
function detailsPanel(): string | null {
    return guideTarget('details.flow')?.getAttribute('data-panel') ?? null;
}

const STEPPER_PANELS = ['details', 'documents', 'review'];

function onPanel(panel: string): boolean {
    return detailsPanel() === panel;
}

/**
 * On the stepper, short of `panel`: the counter then counts that panel's fixed
 * steps ahead of time, so its total does not end on "Save this step". Only
 * for a step that is reached through an action step completing on its own
 * panel, so it is never reached while still ahead.
 */
function ahead(panel: string): boolean {
    const now = STEPPER_PANELS.indexOf(detailsPanel() ?? '');
    return now !== -1 && now < STEPPER_PANELS.indexOf(panel);
}

/** Something is still missing on Check & finish: the link back to it shows. */
function missingShown(): boolean {
    return onPanel('review') && guideTarget('details.review.fix') !== null;
}

/** Finish is on screen and can be pressed (never while something is missing). */
function finishLive(): boolean {
    const finish = guideTarget('details.review.finish');
    return onPanel('review') && !missingShown() && finish !== null && !finish.hasAttribute('disabled');
}

function attribute(name: string, attr: string): string | null {
    return guideTarget(name)?.getAttribute(attr) ?? null;
}

/** The questions, in the order the Details form shows them (`visibleFieldKeys`). */
const FIELD_KEYS = [
    'work_authorization',
    'date_available',
    'desired_pay',
    'home_address',
    'date_of_birth',
    'emergency_contact',
    'worked_here_before',
    'education',
    'references',
    'work_history',
    'military_service',
] as const;

/** Questions answered with one tap of Yes or No: the step moves on by itself. */
const ONE_TAP_FIELDS: ReadonlySet<string> = new Set(['work_authorization']);

function fieldSteps(key: (typeof FIELD_KEYS)[number]): SpotlightStep[] {
    const name = `details.field.${key}`;
    const id = `field_${key}`;
    const complete = (control: Element) => control.getAttribute('data-complete') === 'true';
    const required: SpotlightStep = ONE_TAP_FIELDS.has(key)
        ? {
              id,
              target: { guide: name },
              when: () => onPanel('details') && attribute(name, 'data-required') === 'true',
              mode: 'auto',
              advanceWhen: complete,
              ...copy(id),
          }
        : {
              id,
              target: { guide: name },
              when: () => onPanel('details') && attribute(name, 'data-required') === 'true',
              mode: 'next',
              ready: complete,
              ...copy(id),
          };
    const optional: SpotlightStep = {
        id: `${id}_optional`,
        target: { guide: name },
        when: () => onPanel('details') && attribute(name, 'data-required') === 'false',
        mode: 'next',
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body_optional`,
    };
    return [required, optional];
}

/** The documents a job can ask for one file of, in the order the step lists them. */
const DOC_TYPES = ['resume', 'driver_license', 'work_auth_doc'] as const;

function docSteps(docType: (typeof DOC_TYPES)[number]): SpotlightStep[] {
    const name = `details.doc.${docType}`;
    const id = `doc_${docType}`;
    const saved = (control: Element) => control.getAttribute('data-saved') === 'true';
    const showing = (isSaved: 'true' | 'false') => onPanel('documents') && attribute(name, 'data-saved') === isSaved;
    return [
        // First, so a file uploaded during the upload step below does not
        // bring this one up for the same row right after.
        {
            id: `${id}_saved`,
            target: { guide: name },
            when: () => showing('true'),
            mode: 'next',
            titleKey: `${KEY}.steps.${id}.saved_title`,
            bodyKey: `${KEY}.steps.${id}.saved_body`,
        },
        {
            id: `${id}_upload`,
            target: { guide: name },
            when: () => showing('false') && attribute(name, 'data-required') === 'true',
            mode: 'auto',
            advanceWhen: saved,
            ...copy(id),
        },
        {
            id: `${id}_upload_optional`,
            target: { guide: name },
            when: () => showing('false') && attribute(name, 'data-required') === 'false',
            mode: 'auto',
            advanceWhen: saved,
            ready: () => true,
            titleKey: `${KEY}.steps.${id}.title`,
            bodyKey: `${KEY}.steps.${id}.body_optional`,
        },
    ];
}

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.worker_details.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [
        // The employer's questions from applying, when some are unanswered.
        {
            id: 'prompts',
            target: { guide: 'details.prompts' },
            when: () => onPanel('topup'),
            mode: 'next',
            ready: (control) => {
                const boxes = Array.from(control.querySelectorAll('textarea'));
                return (
                    boxes.length > 0 &&
                    boxes.every((box) => {
                        const length = box.value.trim().length;
                        return length > 0 && length <= MAX_PROMPT_ANSWER_CHARS;
                    })
                );
            },
            ...copy('prompts'),
        },
        {
            id: 'prompts_save',
            target: { guide: 'details.prompts.save' },
            when: () => onPanel('topup'),
            mode: 'action',
            placement: 'top',
            advanceWhen: () => detailsPanel() !== 'topup',
            ...copy('prompts_save'),
        },

        // The bar and the three steps.
        {
            id: 'overview',
            target: { guide: 'details.overview' },
            when: () => STEPPER_PANELS.includes(detailsPanel() ?? ''),
            mode: 'next',
            interactive: false,
            ready: () => attribute('details.flow', 'data-vault') !== 'pending',
            ...copy('overview'),
        },

        // Details.
        ...FIELD_KEYS.flatMap(fieldSteps),
        {
            id: 'details_continue',
            target: { guide: 'details.questions.continue' },
            when: () => onPanel('details'),
            mode: 'action',
            placement: 'top',
            advanceWhen: () => onPanel('documents'),
            ...copy('details_continue'),
        },

        // Documents & certifications.
        {
            id: 'vault_retry',
            target: { guide: 'details.vault_retry' },
            when: () => onPanel('documents') && guideTarget('details.vault_retry') !== null,
            mode: 'action',
            advanceWhen: () => guideTarget('details.vault_retry') === null,
            ...copy('vault_retry'),
        },
        {
            id: 'doc_notice_legacy',
            target: { guide: 'details.doc_notice.legacy' },
            when: () => onPanel('documents') && guideTarget('details.doc_notice.legacy') !== null,
            mode: 'next',
            ...copy('doc_notice_legacy', false),
        },
        {
            id: 'doc_notice_unknown',
            target: { guide: 'details.doc_notice.unknown' },
            when: () => onPanel('documents') && guideTarget('details.doc_notice.unknown') !== null,
            mode: 'next',
            ...copy('doc_notice_unknown', false),
        },
        ...DOC_TYPES.flatMap(docSteps),
        {
            id: 'certification_doc',
            target: { guide: 'details.doc.certification_doc' },
            when: () => onPanel('documents') && guideTarget('details.doc.certification_doc') !== null,
            mode: 'next',
            ready: (control) =>
                control.getAttribute('data-required') !== 'true' || Number(control.getAttribute('data-count')) > 0,
            ...copy('certification_doc'),
        },
        {
            id: 'certifications',
            target: { guide: 'details.certs' },
            when: () => onPanel('documents') && guideTarget('details.certs') !== null,
            mode: 'next',
            ready: (control) => control.querySelector('[data-cert-ready="false"]') === null,
            ...copy('certifications'),
        },
        {
            id: 'documents_continue',
            target: { guide: 'details.documents.continue' },
            // Reached only once "Save and continue" has opened Documents.
            when: () => onPanel('documents') || ahead('documents'),
            mode: 'action',
            placement: 'top',
            advanceWhen: () => onPanel('review'),
            ...copy('documents_continue'),
        },

        // Check & finish.
        {
            id: 'review_summary',
            target: { guide: 'details.review.summary' },
            // Reached only once Continue has opened Check & finish.
            when: () => onPanel('review') || ahead('review'),
            mode: 'next',
            ...copy('review_summary', false),
        },
        // The last step of its branch: the guide cannot walk the earlier steps
        // again, so it says it ends here, and ends when the link is tapped.
        // Finish and the completion screen below never apply while something
        // is missing, so the counter's total ends on this step.
        {
            id: 'review_missing',
            target: { guide: 'details.review.fix' },
            when: missingShown,
            mode: 'action',
            advanceWhen: () => !onPanel('review'),
            ...copy('review_missing'),
        },
        {
            id: 'review_finish',
            target: { guide: 'details.review.finish' },
            when: finishLive,
            mode: 'action',
            placement: 'top',
            advanceWhen: () => onPanel('complete'),
            ...copy('review_finish'),
        },

        // Sent.
        {
            id: 'complete',
            target: { guide: 'details.complete.back' },
            // Counted from a live Finish on; reached only once Finish has sent.
            when: () => onPanel('complete') || finishLive(),
            mode: 'next',
            placement: 'top',
            ...copy('complete', false),
        },
    ],
};

export default guide;
