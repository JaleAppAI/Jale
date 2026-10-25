import type { TourId } from '@/lib/api/tutorials';

/**
 * The app tour's content and geometry, kept free of React so the step rules
 * and the callout placement can be tested on their own. Only the tour overlay
 * (`AppTour`, inside the lazily loaded `AppTourHost` chunk) imports it.
 *
 * STEPS. Each step points at one element on the page: a navigation link by its
 * `data-nav-key` (the keys in `components/layout/nav-config.ts`) or a marked
 * control by its `data-tour`. Where the same key is rendered twice (the
 * desktop sidebar and the phone tab bar), the step uses the first copy that is
 * actually rendered, so the tour follows whichever navigation the screen shows.
 * A step whose element is not on screen when the tour starts is left out, so
 * the phone tour has no Templates or Billing step (they live in the sidebar
 * only) and the counter's total is the number of steps the person will see.
 *
 * TITLES reuse the navigation's own label keys where they say the same thing,
 * so renaming a tab renames its step. Keys are full paths from the catalogue's
 * root.
 */

export type TourTarget = { nav: string } | { tour: string };

export type TourStep = {
    /** Stable name, used for test ids and React keys. */
    key: string;
    target: TourTarget;
    titleKey: string;
    bodyKey: string;
};

export type TourWelcome = {
    titleKey: string;
    bodyKey: string;
    startKey: string;
    notNowKey: string;
};

const HELP_TITLE = 'tutorial.common.help';

const EMPLOYER_STEPS: readonly TourStep[] = [
    { key: 'dashboard', target: { nav: 'dashboard' }, titleKey: 'employer_dashboard.nav.dashboard', bodyKey: 'tutorial.tour.employer.dashboard_body' },
    { key: 'post_job', target: { tour: 'post-job' }, titleKey: 'tutorial.tour.employer.post_job_title', bodyKey: 'tutorial.tour.employer.post_job_body' },
    { key: 'messages', target: { nav: 'messages' }, titleKey: 'employer_dashboard.nav.messages', bodyKey: 'tutorial.tour.employer.messages_body' },
    { key: 'applicants', target: { nav: 'applicants' }, titleKey: 'employer_dashboard.nav.applicants', bodyKey: 'tutorial.tour.employer.applicants_body' },
    { key: 'templates', target: { nav: 'templates' }, titleKey: 'employer_dashboard.nav.templates', bodyKey: 'tutorial.tour.employer.templates_body' },
    { key: 'billing', target: { nav: 'billing' }, titleKey: 'employer_dashboard.nav.billing', bodyKey: 'tutorial.tour.employer.billing_body' },
    { key: 'settings', target: { nav: 'settings' }, titleKey: 'employer_dashboard.nav.settings', bodyKey: 'tutorial.tour.employer.settings_body' },
    { key: 'help', target: { tour: 'help' }, titleKey: HELP_TITLE, bodyKey: 'tutorial.tour.employer.help_body' },
];

const WORKER_STEPS: readonly TourStep[] = [
    { key: 'find_jobs', target: { nav: 'find_jobs' }, titleKey: 'header.worker_home', bodyKey: 'tutorial.tour.worker.find_jobs_body' },
    { key: 'applications', target: { nav: 'applications' }, titleKey: 'header.my_applications', bodyKey: 'tutorial.tour.worker.applications_body' },
    { key: 'profile', target: { nav: 'profile' }, titleKey: 'header.profile', bodyKey: 'tutorial.tour.worker.profile_body' },
    { key: 'help', target: { tour: 'help' }, titleKey: HELP_TITLE, bodyKey: 'tutorial.tour.worker.help_body' },
];

export const TOUR_STEPS: Readonly<Record<TourId, readonly TourStep[]>> = {
    employer_app_tour: EMPLOYER_STEPS,
    worker_app_tour: WORKER_STEPS,
};

export const TOUR_WELCOME: Readonly<Record<TourId, TourWelcome>> = {
    employer_app_tour: {
        titleKey: 'tutorial.tour.employer.welcome_title',
        bodyKey: 'tutorial.tour.employer.welcome_body',
        startKey: 'tutorial.tour.employer.start',
        notNowKey: 'tutorial.tour.employer.not_now',
    },
    worker_app_tour: {
        titleKey: 'tutorial.tour.worker.welcome_title',
        bodyKey: 'tutorial.tour.worker.welcome_body',
        startKey: 'tutorial.tour.worker.start',
        notNowKey: 'tutorial.tour.worker.not_now',
    },
};

export function targetSelector(target: TourTarget): string {
    return 'nav' in target ? `[data-nav-key="${target.nav}"]` : `[data-tour="${target.tour}"]`;
}

/** Rendered: laid out at all (an ancestor with `display: none` gives no boxes). */
export function isRendered(element: Element): boolean {
    return element.getClientRects().length > 0;
}

/** The first rendered element `target` names, or null when none is on screen. */
export function findTarget(target: TourTarget, root: ParentNode = document): HTMLElement | null {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(targetSelector(target)))) {
        if (isRendered(element)) return element;
    }
    return null;
}

/** The steps whose element is on screen now, in tour order. */
export function buildSteps(steps: readonly TourStep[], available: (step: TourStep) => boolean): TourStep[] {
    return steps.filter(available);
}

/**
 * From `from`, the next step in `direction` whose element is still on screen,
 * or -1 when there is none: a step whose element has gone since the tour
 * started is passed over.
 */
export function nextAvailable(
    steps: readonly TourStep[],
    from: number,
    direction: 1 | -1,
    available: (step: TourStep) => boolean,
): number {
    for (let index = from + direction; index >= 0 && index < steps.length; index += direction) {
        if (available(steps[index])) return index;
    }
    return -1;
}

// ---- Placement -------------------------------------------------------------

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };
/** Which side of the target the callout sits on. */
export type Side = 'top' | 'bottom' | 'right';
export type Placement = {
    side: Side;
    top: number;
    left: number;
    /**
     * Where the arrow points, measured along the callout edge that faces the
     * target: from its left edge for `top`/`bottom`, from its top edge for
     * `right`.
     */
    arrow: number;
};

/** The callout never comes closer than this to the viewport's edges. */
export const VIEWPORT_GUTTER = 16;
/** Space between the target and the edge of the cutout around it. */
export const CUTOUT_PAD = 6;
/** Space between the cutout and the callout (the arrow sits in it). */
export const CALLOUT_GAP = 14;
/** The arrow keeps clear of the callout's rounded corners. */
export const ARROW_INSET = 22;
/** The callout's widest; narrower screens take their width less the gutters. */
export const CALLOUT_MAX_WIDTH = 360;

function clamp(value: number, min: number, max: number): number {
    // On a screen too small for the callout, the start edge wins.
    return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** The cutout drawn around `target`. */
export function cutoutFor(target: Box): Box {
    return {
        top: target.top - CUTOUT_PAD,
        left: target.left - CUTOUT_PAD,
        width: target.width + CUTOUT_PAD * 2,
        height: target.height + CUTOUT_PAD * 2,
    };
}

/**
 * Where the callout goes for a target, all in viewport pixels.
 *
 *  - A target in the lower part of the screen (the phone tab bar): ABOVE it.
 *  - A narrow target at the left (the desktop sidebar): to its RIGHT, when the
 *    callout fits there.
 *  - Anything else (a header button): BELOW it, or above when below has no room.
 *
 * The callout then slides along that side to stay inside the viewport, and the
 * arrow follows the target's centre.
 */
export function placeCallout(target: Box, callout: Size, viewport: Size): Placement {
    const hole = cutoutFor(target);
    const holeBottom = hole.top + hole.height;
    const holeRight = hole.left + hole.width;
    const centerX = target.left + target.width / 2;
    const centerY = target.top + target.height / 2;

    const fitsAbove = hole.top - CALLOUT_GAP - callout.height >= VIEWPORT_GUTTER;
    const fitsBelow = holeBottom + CALLOUT_GAP + callout.height <= viewport.height - VIEWPORT_GUTTER;
    const fitsRight = holeRight + CALLOUT_GAP + callout.width <= viewport.width - VIEWPORT_GUTTER;
    const inLeftRail = centerX < viewport.width / 3 && target.width < viewport.width / 3;

    let side: Side;
    if (centerY > viewport.height * 0.6 && fitsAbove) side = 'top';
    else if (inLeftRail && fitsRight) side = 'right';
    else if (fitsBelow) side = 'bottom';
    else if (fitsAbove) side = 'top';
    else side = viewport.height - holeBottom >= hole.top ? 'bottom' : 'top';

    const maxTop = viewport.height - VIEWPORT_GUTTER - callout.height;
    const maxLeft = viewport.width - VIEWPORT_GUTTER - callout.width;

    if (side === 'right') {
        const top = clamp(centerY - callout.height / 2, VIEWPORT_GUTTER, maxTop);
        return {
            side,
            top,
            left: holeRight + CALLOUT_GAP,
            arrow: clamp(centerY - top, ARROW_INSET, callout.height - ARROW_INSET),
        };
    }

    const left = clamp(centerX - callout.width / 2, VIEWPORT_GUTTER, maxLeft);
    const rawTop = side === 'bottom' ? holeBottom + CALLOUT_GAP : hole.top - CALLOUT_GAP - callout.height;
    return {
        side,
        top: clamp(rawTop, VIEWPORT_GUTTER, maxTop),
        left,
        arrow: clamp(centerX - left, ARROW_INSET, callout.width - ARROW_INSET),
    };
}
