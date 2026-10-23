import { describe, expect, it } from 'vitest';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS } from '@/lib/api/tutorials';
import type { TutorialDefinition } from '../types';
import employerWelcome from '@/components/tutorials/content/employer-welcome';
import employerPostJob from '@/components/tutorials/content/employer-post-job';
import employerApplicants from '@/components/tutorials/content/employer-applicants';
import employerMessages from '@/components/tutorials/content/employer-messages';
import workerOnboarding from '@/components/tutorials/content/worker-onboarding';
import workerApply from '@/components/tutorials/content/worker-apply';
import workerDetails from '@/components/tutorials/content/worker-details';
import workerProfile from '@/components/tutorials/content/worker-profile';

/**
 * The content files' shape, as the registry and Help rely on it. Only what
 * stays true once the content lanes fill these files with real slides is
 * checked: their own id, role and namespace. The framework's behaviour is
 * covered by `use-tutorial.test.tsx`, `progress.test.tsx` and the player's
 * own suite.
 */

describe('tutorial content placeholders', () => {
  const CONTENT: ReadonlyArray<[string, TutorialDefinition, 'employer' | 'worker']> = [
    ['employer-welcome', employerWelcome, 'employer'],
    ['employer-post-job', employerPostJob, 'employer'],
    ['employer-applicants', employerApplicants, 'employer'],
    ['employer-messages', employerMessages, 'employer'],
    ['worker-onboarding', workerOnboarding, 'worker'],
    ['worker-apply', workerApply, 'worker'],
    ['worker-details', workerDetails, 'worker'],
    ['worker-profile', workerProfile, 'worker'],
  ];

  it('covers every contract id exactly once', () => {
    expect(CONTENT.map(([, definition]) => definition.id)).toEqual([
      ...EMPLOYER_TUTORIAL_IDS,
      ...WORKER_TUTORIAL_IDS,
    ]);
  });

  // Only what stays true once the content lanes fill these files: the slides
  // themselves are theirs to change.
  it.each(CONTENT)('%s exports its own id, role and namespace', (file, definition, role) => {
    expect(definition.id).toBe(file.replace(/-/g, '_'));
    expect(definition.role).toBe(role);
    expect(definition.namespace).toBe(`tutorial.${definition.id}`);
  });
});
