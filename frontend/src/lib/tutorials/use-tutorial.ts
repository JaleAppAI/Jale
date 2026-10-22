'use client';

import type { TutorialId } from '@/lib/api/tutorials';
import type { TutorialHandle, UseTutorialOptions } from './types';

/**
 * PLACEHOLDER handle. Nothing auto-opens and nothing replays, and a
 * "before the host" call opens the host at once, which is exactly what the
 * real hook does whenever a tutorial is not allowed to play. One shared object,
 * so its identity is stable across renders.
 */
const PLACEHOLDER_HANDLE: TutorialHandle = {
  maybeAutoOpen() {},
  runBeforeHost(openHost) {
    openHost();
  },
  replay() {},
};

/**
 * The tutorial a host page plays (see `TutorialHandle` in `./types`).
 *
 * PLACEHOLDER. The signature is final so host pages can call it now; the
 * tutorial framework lane fills in the body.
 */
export function useTutorial(id: TutorialId, options: UseTutorialOptions): TutorialHandle {
  void id;
  void options;
  return PLACEHOLDER_HANDLE;
}
