import { customTradeAcceptable } from '@/lib/onboarding-flow';
import { splitDedupe } from '@/lib/text';
import { guideTarget } from '../spotlight/steps';
import { fieldIn, hasText, valueOf } from './dom';
import type { WalkthroughGuide } from './types';

/**
 * W4's step-by-step guide: updating the profile on `/worker/profile`, a page
 * of its own (no dialog). The page asks for it with `maybeAutoOpen` and
 * `walkthrough: true`; Help's Play keeps the slides.
 *
 * Edit, then the edit form's controls in the order it shows them, then the
 * Documents card under the form, then Save. The targets are the
 * `data-guide="profile.*"` marks in the page and `ProfileEditForm`.
 *
 *  - Edit: completes when the form is up. The button goes with the click, so
 *    the step's `when` (no form yet) is what moves it on; a guide started
 *    with the form already open skips it.
 *  - Full name: only while it is empty (the form cannot be saved without
 *    one, and no later step reaches it).
 *  - Trade: moves on once one is picked; a stored trade shows Next.
 *  - Your trade (Other): only while Other is picked; Next once it holds 2 to
 *    60 characters, trimmed, as the form will save it.
 *  - Skills: Next once there is one comma-separated item.
 *  - Availability: Next once one is chosen (an unset one starts empty).
 *  - Years: optional; Next unless the box holds something other than a whole
 *    number from 0 to 80.
 *  - Location: Next once there is text; the copy asks for a picked city.
 *  - Cities: optional.
 *  - Documents: the card, with its Upload and Replace buttons in reach.
 *  - Save: completes when the form is gone and "Saved" shows. A "Please
 *    add: …" warning keeps the form, so the step stays.
 *  - Saved: the closing word, pointed at the page's own "Saved" notice. A
 *    step, not a static closing card, so it shows only when the save
 *    happened: a worker who cancels, or leaves the page, is never told the
 *    profile was saved.
 *
 * Every form step applies only while the form is up, so once Save has
 * closed it nothing is left waiting for a control that went with it.
 */

const KEY = 'tutorial.worker_profile.guide';

function step(id: string, wait = true) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        ...(wait ? { waitKey: `${KEY}.steps.${id}.wait` } : {}),
    };
}

/** The edit form is on screen. */
function formUp(): boolean {
    return guideTarget('profile.form') !== null;
}

/**
 * Empty (unless the profile had a number, which cannot be cleared), or a whole
 * number of years from 0 to 80 (what the server accepts).
 */
function yearsAcceptable(control: Element): boolean {
    const field = fieldIn(control);
    const raw = field?.value.trim() ?? '';
    if (raw === '') return !(field?.hasAttribute('data-stored') ?? false);
    const years = Number(raw);
    return Number.isInteger(years) && years >= 0 && years <= 80;
}

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.worker_profile.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [
        {
            id: 'edit',
            target: { guide: 'profile.edit' },
            when: () => !formUp(),
            mode: 'action',
            advanceWhen: formUp,
            ...step('edit'),
        },
        {
            id: 'name',
            target: { guide: 'profile.name' },
            when: () => formUp() && (valueOf('profile.name') ?? '').trim() === '',
            mode: 'next',
            ready: hasText,
            ...step('name'),
        },
        {
            id: 'trade',
            target: { guide: 'profile.trade' },
            when: formUp,
            mode: 'auto',
            advanceWhen: hasText,
            ...step('trade'),
        },
        {
            id: 'trade_other',
            target: { guide: 'profile.trade_other' },
            when: () => formUp() && valueOf('profile.trade') === 'other',
            mode: 'next',
            ready: (control) => customTradeAcceptable(fieldIn(control)?.value ?? ''),
            ...step('trade_other'),
        },
        {
            id: 'skills',
            target: { guide: 'profile.skills' },
            when: formUp,
            mode: 'next',
            ready: (control) => splitDedupe(fieldIn(control)?.value ?? '').length > 0,
            ...step('skills'),
        },
        {
            id: 'availability',
            target: { guide: 'profile.availability' },
            when: formUp,
            mode: 'next',
            ready: hasText,
            ...step('availability'),
        },
        {
            id: 'years',
            target: { guide: 'profile.years' },
            when: formUp,
            mode: 'next',
            ready: yearsAcceptable,
            ...step('years'),
        },
        {
            id: 'location',
            target: { guide: 'profile.location' },
            when: formUp,
            mode: 'next',
            // Above the field, so the suggestion list opening below it stays clear.
            placement: 'top',
            ready: hasText,
            ...step('location'),
        },
        {
            id: 'cities',
            target: { guide: 'profile.cities' },
            when: formUp,
            mode: 'next',
            placement: 'top',
            ...step('cities', false),
        },
        {
            id: 'documents',
            target: { guide: 'profile.documents' },
            when: formUp,
            mode: 'next',
            ...step('documents', false),
        },
        {
            id: 'save',
            target: { guide: 'profile.save' },
            when: formUp,
            mode: 'action',
            placement: 'top',
            advanceWhen: () => !formUp() && guideTarget('profile.saved') !== null,
            ...step('save'),
        },
        {
            id: 'saved',
            target: { guide: 'profile.saved' },
            when: () => !formUp() && guideTarget('profile.saved') !== null,
            mode: 'next',
            titleKey: `${KEY}.done.title`,
            bodyKey: `${KEY}.done.body`,
        },
    ],
};

export default guide;
