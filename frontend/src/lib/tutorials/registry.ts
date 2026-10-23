import {
    EMPLOYER_TUTORIAL_IDS,
    WORKER_TUTORIAL_IDS,
    type TutorialId,
    type TutorialRole,
} from '@/lib/api/tutorials';
import employerWelcome from '@/components/tutorials/content/employer-welcome';
import employerPostJob from '@/components/tutorials/content/employer-post-job';
import employerApplicants from '@/components/tutorials/content/employer-applicants';
import employerMessages from '@/components/tutorials/content/employer-messages';
import workerOnboarding from '@/components/tutorials/content/worker-onboarding';
import workerApply from '@/components/tutorials/content/worker-apply';
import workerDetails from '@/components/tutorials/content/worker-details';
import workerProfile from '@/components/tutorials/content/worker-profile';
import type { TutorialDefinition } from './types';

/**
 * Every tutorial, by its contract id (K1.1). The content files are the
 * content lanes' (FE-2 employer, FE-3 worker); this map is the only place
 * that knows where they live.
 */
export const TUTORIALS: Readonly<Record<TutorialId, TutorialDefinition>> = {
    employer_welcome: employerWelcome,
    employer_post_job: employerPostJob,
    employer_applicants: employerApplicants,
    employer_messages: employerMessages,
    worker_onboarding: workerOnboarding,
    worker_apply: workerApply,
    worker_details: workerDetails,
    worker_profile: workerProfile,
};

export function getTutorial(id: TutorialId): TutorialDefinition | undefined {
    return TUTORIALS[id];
}

/** A role's tutorials in contract order: the order Help lists them in. */
export function tutorialsForRole(role: TutorialRole): readonly TutorialDefinition[] {
    const ids: readonly TutorialId[] = role === 'employer' ? EMPLOYER_TUTORIAL_IDS : WORKER_TUTORIAL_IDS;
    return ids.map((id) => TUTORIALS[id]);
}
