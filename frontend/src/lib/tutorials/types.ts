import type { ComponentType } from 'react';
import type { TutorialId, TutorialRole } from '@/lib/api/tutorials';

/** One slide: a title, one or two short sentences, and an animated mock scene. */
export interface TutorialSlide {
  id: string;                              // unique within the tutorial, e.g. 'share-link'
  titleKey: string;                        // i18n key under the tutorial's namespace
  bodyKey: string;
  Scene: ComponentType<TutorialSceneProps>;
}

/** Scenes render the mock UI. `still` is true under reduced motion: render the final frame, no animation. */
export interface TutorialSceneProps {
  still: boolean;
  /** Values the host passes in (e.g. the plan's real active-job limit for E1). */
  vars?: Readonly<Record<string, string | number>>;
}

export interface TutorialDefinition {
  id: TutorialId;
  role: TutorialRole;
  namespace: string;                       // i18n namespace, e.g. 'tutorial.employer_welcome'
  titleKey: string;                        // shown in the Help list and as the modal's accessible name
  slides: readonly TutorialSlide[];        // 3–5
}

/** What a host page gets from useTutorial(id, …). */
export interface TutorialHandle {
  /** Auto-open if allowed (see the rule in `use-tutorial.ts`). Call it once per page view, from an effect when the page is ready. */
  maybeAutoOpen(vars?: TutorialSceneProps['vars']): void;
  /** For tutorials that play before a host (E2, E4): auto-plays if allowed, then calls openHost on dismiss; otherwise calls openHost at once. */
  runBeforeHost(openHost: () => void, vars?: TutorialSceneProps['vars']): void;
  /** Replay from Help. Never records. */
  replay(vars?: TutorialSceneProps['vars']): void;
}

export interface UseTutorialOptions {
  /** K1.5 "has done the task": true = never auto-open; undefined = still loading (do not auto-open yet). */
  done: boolean | undefined;
}
