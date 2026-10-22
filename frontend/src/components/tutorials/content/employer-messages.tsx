import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * PLACEHOLDER for the `employer_messages` tutorial: one slide whose scene renders nothing,
 * so the registry and host pages have a real module to import. The employer
 * tutorial content lane replaces this file with the real slides and copy; no
 * i18n keys exist for it yet.
 */
function PlaceholderScene() {
  return null;
}

const employerMessages: TutorialDefinition = {
  id: 'employer_messages',
  role: 'employer',
  namespace: 'tutorial.employer_messages',
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

export default employerMessages;
