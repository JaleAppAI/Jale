import { describe, expect, it } from 'vitest';
import {
    ARROW_INSET,
    CALLOUT_GAP,
    CUTOUT_PAD,
    TOUR_STEPS,
    VIEWPORT_GUTTER,
    buildSteps,
    nextAvailable,
    placeCallout,
    targetSelector,
    type TourStep,
} from '../app-tour-model';

/*
 * The app tour's pure rules: which steps a screen gets, how a vanished
 * control is passed over, and where the callout goes beside its control.
 */

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 800 };
const callout = { width: 358, height: 160 };

const keys = (steps: readonly TourStep[]) => steps.map((step) => step.key);

describe('app tour steps', () => {
    it('lists the employer tour in order: dashboard, post a job, the nav, then Help', () => {
        expect(keys(TOUR_STEPS.employer_app_tour)).toEqual([
            'dashboard',
            'post_job',
            'messages',
            'applicants',
            'templates',
            'billing',
            'settings',
            'help',
        ]);
        expect(keys(TOUR_STEPS.worker_app_tour)).toEqual(['find_jobs', 'applications', 'profile', 'help']);
    });

    it('points nav steps at their nav key and the rest at a data-tour mark', () => {
        expect(targetSelector({ nav: 'messages' })).toBe('[data-nav-key="messages"]');
        expect(targetSelector({ tour: 'post-job' })).toBe('[data-tour="post-job"]');
    });

    it('keeps only the steps whose control is on screen', () => {
        const onPhone = new Set(['dashboard', 'post_job', 'messages', 'applicants', 'settings', 'help']);
        expect(keys(buildSteps(TOUR_STEPS.employer_app_tour, (step) => onPhone.has(step.key)))).toEqual([
            'dashboard',
            'post_job',
            'messages',
            'applicants',
            'settings',
            'help',
        ]);
    });

    it('passes over a step whose control has gone, in either direction', () => {
        const steps = TOUR_STEPS.worker_app_tour;
        const gone = new Set(['applications']);
        const available = (step: TourStep) => !gone.has(step.key);
        expect(nextAvailable(steps, 0, 1, available)).toBe(2);
        expect(nextAvailable(steps, 2, -1, available)).toBe(0);
        expect(nextAvailable(steps, 3, 1, available)).toBe(-1);
        expect(nextAvailable(steps, 0, -1, available)).toBe(-1);
    });
});

describe('callout placement', () => {
    it('goes above a phone tab, with the arrow at the tab', () => {
        const tab = { top: 784, left: 97, width: 98, height: 60 };
        const placement = placeCallout(tab, callout, phone);
        expect(placement.side).toBe('top');
        expect(placement.top).toBe(tab.top - CUTOUT_PAD - CALLOUT_GAP - callout.height);
        expect(placement.left).toBe(VIEWPORT_GUTTER);
        expect(placement.left + placement.arrow).toBe(tab.left + tab.width / 2);
    });

    it('goes to the right of a sidebar link', () => {
        const link = { top: 128, left: 16, width: 248, height: 44 };
        const placement = placeCallout(link, callout, desktop);
        expect(placement.side).toBe('right');
        expect(placement.left).toBe(link.left + link.width + CUTOUT_PAD + CALLOUT_GAP);
        expect(placement.top + placement.arrow).toBe(link.top + link.height / 2);
    });

    it('goes below a header button and stays inside the viewport', () => {
        const help = { top: 20, left: 1220, width: 44, height: 44 };
        const placement = placeCallout(help, callout, desktop);
        expect(placement.side).toBe('bottom');
        expect(placement.top).toBe(help.top + help.height + CUTOUT_PAD + CALLOUT_GAP);
        expect(placement.left).toBe(desktop.width - VIEWPORT_GUTTER - callout.width);
        // The arrow still points at the button, short of the rounded corner.
        expect(placement.left + placement.arrow).toBe(help.left + help.width / 2);
        expect(placement.arrow).toBeLessThanOrEqual(callout.width - ARROW_INSET);
    });

    it('flips above a low control when there is no room below', () => {
        const low = { top: 700, left: 600, width: 120, height: 40 };
        const placement = placeCallout(low, callout, desktop);
        expect(placement.side).toBe('top');
    });

    it('keeps the arrow off the corners when the control sits at the edge', () => {
        const corner = { top: 790, left: 0, width: 10, height: 40 };
        const placement = placeCallout(corner, callout, phone);
        expect(placement.arrow).toBe(ARROW_INSET);
    });

    it('never places the callout past the gutter on a tiny screen', () => {
        const placement = placeCallout({ top: 10, left: 10, width: 40, height: 40 }, callout, { width: 300, height: 200 });
        expect(placement.left).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
        expect(placement.top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
    });
});
