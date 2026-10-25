import type { TutorialId } from '@/lib/api/tutorials';
import type { WalkthroughGuide } from './types';
import employerWelcome from './employer-welcome';
import employerPostJob from './employer-post-job';
import employerApplicants from './employer-applicants';
import employerMessages from './employer-messages';
import workerOnboarding from './worker-onboarding';
import workerApply from './worker-apply';
import workerDetails from './worker-details';
import workerProfile from './worker-profile';

/**
 * Every task's step-by-step guide, by tutorial id: null for a task that keeps
 * its slides only. One module per task, so a guide is written without
 * touching this map.
 *
 * Loaded only with `../GuideHost`, the guides' own lazy chunk: nothing else
 * may import this module statically.
 */
export const GUIDES: Readonly<Record<TutorialId, WalkthroughGuide | null>> = {
    employer_welcome: employerWelcome,
    employer_post_job: employerPostJob,
    employer_applicants: employerApplicants,
    employer_messages: employerMessages,
    worker_onboarding: workerOnboarding,
    worker_apply: workerApply,
    worker_details: workerDetails,
    worker_profile: workerProfile,
};

export function getGuide(id: TutorialId): WalkthroughGuide | null {
    return GUIDES[id] ?? null;
}
