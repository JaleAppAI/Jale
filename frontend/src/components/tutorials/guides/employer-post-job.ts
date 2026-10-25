import { locationDatasetFailed } from '@/lib/location-search';
import { guideTarget } from '../spotlight/steps';
import { fieldIn, hasText, isPicked, valueOf } from './dom';
import type { WalkthroughGuide } from './types';

/**
 * E2's step-by-step guide: posting a job, inside the post-job wizard (a
 * `Modal`; the engine draws the guide inside it). It starts with the wizard,
 * opened by `PostJobContext` with `runWithHost`.
 *
 * This is the wizard's first screen, in the order it shows its fields, then
 * Next and the first field the second screen requires. The targets are the
 * `data-guide="post.*"` marks in `components/employer/PostJobModal.tsx` and
 * `TradeCategoryField.tsx`; `post.form` carries the screen as `data-step`.
 *
 *  - Title: Next once there is a title.
 *  - City: moves on once a suggestion is picked (`data-picked`, set from the
 *    picked city's key): typed text does not count, as for the wizard. If the
 *    city list failed to load, the wizard takes typed text, and so does Next.
 *  - Trade: moves on once one is picked.
 *  - Other trade: only while Other is picked; Next once something is typed.
 *  - Next: completes when the second screen shows, not on the click, since
 *    the wizard may refuse it.
 *  - Workers needed: Next once it is 1 or more.
 */

const KEY = 'tutorial.employer_post_job.guide';

function step(id: string) {
    return {
        titleKey: `${KEY}.steps.${id}.title`,
        bodyKey: `${KEY}.steps.${id}.body`,
        waitKey: `${KEY}.steps.${id}.wait`,
    };
}

/** The wizard's screen, 1 to 3, as its form says. */
function wizardScreen(): string | null {
    return guideTarget('post.form')?.getAttribute('data-step') ?? null;
}

const guide: WalkthroughGuide = {
    intro: {
        eyebrowKey: 'tutorial.employer_post_job.title',
        titleKey: `${KEY}.intro_title`,
        bodyKey: `${KEY}.intro_body`,
    },
    counterKey: `${KEY}.counter`,
    steps: [
        {
            id: 'title',
            target: { guide: 'post.title' },
            mode: 'next',
            ready: hasText,
            ...step('title'),
        },
        {
            id: 'city',
            target: { guide: 'post.city' },
            mode: 'auto',
            // Above the field, so the suggestion list opening below it stays clear.
            placement: 'top',
            advanceWhen: isPicked,
            ready: (control) => isPicked(control) || (locationDatasetFailed() && hasText(control)),
            ...step('city'),
        },
        {
            id: 'trade',
            target: { guide: 'post.trade' },
            mode: 'auto',
            advanceWhen: hasText,
            ...step('trade'),
        },
        {
            id: 'trade_other',
            target: { guide: 'post.trade_other' },
            when: () => valueOf('post.trade') === 'other',
            mode: 'next',
            ready: hasText,
            ...step('trade_other'),
        },
        {
            id: 'next',
            target: { guide: 'post.next' },
            mode: 'action',
            placement: 'top',
            advanceWhen: () => wizardScreen() === '2',
            ...step('next'),
        },
        {
            id: 'workers',
            target: { guide: 'post.workers' },
            mode: 'next',
            ready: (control) => {
                const raw = fieldIn(control)?.value.trim() ?? '';
                return raw !== '' && Number.isInteger(Number(raw)) && Number(raw) >= 1;
            },
            ...step('workers'),
        },
    ],
};

export default guide;
