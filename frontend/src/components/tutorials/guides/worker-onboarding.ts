import type { WalkthroughGuide } from './types';

/**
 * This task's step-by-step guide: none yet, so it keeps its slides. A guide
 * here (see `./types` and `./employer-post-job`) plays at the task, and its
 * host asks for it with `useTutorial(id, { done, walkthrough: true })` or
 * `runWithHost`.
 */
const guide: WalkthroughGuide | null = null;

export default guide;
