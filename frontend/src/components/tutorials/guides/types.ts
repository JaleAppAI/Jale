import type { SpotlightDone, SpotlightStep, SpotlightTarget } from '../spotlight/steps';

/**
 * A task's step-by-step guide (a "walkthrough"): data for the spotlight
 * engine (`../spotlight`), played by `../GuideHost` in lazy mode, so each
 * step's control is looked for when the step is reached.
 *
 * Keys are full paths from the catalogue's root; the guide's own copy lives
 * under `tutorial.<tutorial id>.guide.*`. The intro's buttons ("Guide me",
 * "I'll do it myself", "Don't show this again") and the end button are the
 * shared `tutorial.common.guide.*` ones, chosen by the host.
 *
 * Steps point at controls marked `data-guide="<flow>.<name>"` (`{ guide }`
 * targets; `guideTarget(name)` finds one from a step's condition). A step's
 * `mode` says how it moves on: `next`, `auto` or `action` (see `StepMode`).
 *
 * Example, one step of the post-job guide:
 *
 *     {
 *         id: 'trade_other',
 *         target: { guide: 'post.trade_other' },
 *         when: () => selectValue('post.trade') === 'other',
 *         mode: 'next',
 *         ready: (control) => hasText(control),
 *         titleKey: 'tutorial.employer_post_job.guide.steps.trade_other.title',
 *         bodyKey: 'tutorial.employer_post_job.guide.steps.trade_other.body',
 *         waitKey: 'tutorial.employer_post_job.guide.steps.trade_other.wait',
 *     }
 */
export type WalkthroughGuide = {
    intro: {
        titleKey: string;
        bodyKey: string;
        /** A short line naming the guide, above the intro's title. */
        eyebrowKey?: string;
    };
    /** The callout's counter line, given `current` and `total`, e.g. "Posting a job · {current} of {total}". */
    counterKey?: string;
    steps: readonly SpotlightStep[];
    /** An optional closing card after the last step. */
    done?: SpotlightDone;
    /**
     * What the guide runs in, when its page opens that together with the
     * guide (the post-job wizard, `{ guide: 'post.wizard' }`). Closed before
     * the first step's control shows, the play ends at once, with no outcome.
     */
    host?: SpotlightTarget;
};
