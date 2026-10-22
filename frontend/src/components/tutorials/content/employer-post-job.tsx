import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * PLACEHOLDER for the `employer_post_job` tutorial: one slide whose scene renders nothing,
 * so the registry and host pages have a real module to import. The employer
 * tutorial content lane replaces this file with the real slides and copy; no
 * i18n keys exist for it yet.
 */
function PlaceholderScene() {
  return null;
}

const employerPostJob: TutorialDefinition = {
  id: 'employer_post_job',
  role: 'employer',
  namespace: 'tutorial.employer_post_job',
  titleKey: 'title',
  slides: [
    {
      id: 'placeholder',
      titleKey: 'placeholder.title',
      bodyKey: 'placeholder.body',
      Scene: PlaceholderScene,
    },
  ],
};

export default employerPostJob;
