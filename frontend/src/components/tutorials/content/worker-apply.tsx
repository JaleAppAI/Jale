import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * PLACEHOLDER for the `worker_apply` tutorial: one slide whose scene renders nothing,
 * so the registry and host pages have a real module to import. The worker
 * tutorial content lane replaces this file with the real slides and copy; no
 * i18n keys exist for it yet.
 */
function PlaceholderScene() {
  return null;
}

const workerApply: TutorialDefinition = {
  id: 'worker_apply',
  role: 'worker',
  namespace: 'tutorial.worker_apply',
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

export default workerApply;
