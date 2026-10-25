import type { TourId } from '@/lib/api/tutorials';
import type { SpotlightIntro, SpotlightStep } from './spotlight/steps';

/**
 * The app tours' content: the first client of the spotlight engine
 * (`./spotlight`). One list per role, in tour order; the engine drops the
 * steps whose control is not on screen when the tour starts, so the phone
 * tour has no Templates or Billing step (they live in the sidebar only).
 *
 * Titles reuse the navigation's own label keys where they say the same thing,
 * so renaming a tab renames its step. Keys are full paths from the
 * catalogue's root. The highlighted controls are shown, not offered: no step
 * is `interactive`.
 */

const HELP_TITLE = 'tutorial.common.help';

const EMPLOYER_STEPS: readonly SpotlightStep[] = [
    { id: 'dashboard', target: { nav: 'dashboard' }, titleKey: 'employer_dashboard.nav.dashboard', bodyKey: 'tutorial.tour.employer.dashboard_body' },
    { id: 'post_job', target: { tour: 'post-job' }, titleKey: 'tutorial.tour.employer.post_job_title', bodyKey: 'tutorial.tour.employer.post_job_body' },
    { id: 'messages', target: { nav: 'messages' }, titleKey: 'employer_dashboard.nav.messages', bodyKey: 'tutorial.tour.employer.messages_body' },
    { id: 'applicants', target: { nav: 'applicants' }, titleKey: 'employer_dashboard.nav.applicants', bodyKey: 'tutorial.tour.employer.applicants_body' },
    { id: 'templates', target: { nav: 'templates' }, titleKey: 'employer_dashboard.nav.templates', bodyKey: 'tutorial.tour.employer.templates_body' },
    { id: 'billing', target: { nav: 'billing' }, titleKey: 'employer_dashboard.nav.billing', bodyKey: 'tutorial.tour.employer.billing_body' },
    { id: 'settings', target: { nav: 'settings' }, titleKey: 'employer_dashboard.nav.settings', bodyKey: 'tutorial.tour.employer.settings_body' },
    { id: 'help', target: { tour: 'help' }, titleKey: HELP_TITLE, bodyKey: 'tutorial.tour.employer.help_body' },
];

const WORKER_STEPS: readonly SpotlightStep[] = [
    { id: 'find_jobs', target: { nav: 'find_jobs' }, titleKey: 'header.worker_home', bodyKey: 'tutorial.tour.worker.find_jobs_body' },
    { id: 'applications', target: { nav: 'applications' }, titleKey: 'header.my_applications', bodyKey: 'tutorial.tour.worker.applications_body' },
    { id: 'profile', target: { nav: 'profile' }, titleKey: 'header.profile', bodyKey: 'tutorial.tour.worker.profile_body' },
    { id: 'help', target: { tour: 'help' }, titleKey: HELP_TITLE, bodyKey: 'tutorial.tour.worker.help_body' },
];

export const TOUR_STEPS: Readonly<Record<TourId, readonly SpotlightStep[]>> = {
    employer_app_tour: EMPLOYER_STEPS,
    worker_app_tour: WORKER_STEPS,
};

export const TOUR_INTRO: Readonly<Record<TourId, SpotlightIntro>> = {
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
