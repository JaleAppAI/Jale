import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS } from '@/lib/api/tutorials';
import { OverlayPresenceProvider, useOverlayPresence } from '../overlay';
import { TutorialProgressProvider } from '../progress';
import { useTutorial } from '../use-tutorial';
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
 * The placeholder contract the content lanes and host pages build against
 * before the tutorial framework lands: the hook and providers keep their
 * final signatures and do nothing, except that a "before the host" call opens
 * the host at once. The tutorial framework lane replaces these bodies and this
 * suite with its own.
 */

describe('useTutorial placeholder', () => {
  it('runBeforeHost opens the host at once', () => {
    const { result } = renderHook(() => useTutorial('employer_post_job', { done: false }));
    const openHost = vi.fn();

    result.current.runBeforeHost(openHost);

    expect(openHost).toHaveBeenCalledTimes(1);
    expect(openHost).toHaveBeenCalledWith();
  });

  it('maybeAutoOpen and replay open nothing', () => {
    const { result } = renderHook(() => useTutorial('worker_apply', { done: false }));

    result.current.maybeAutoOpen({ limit: 1 });
    result.current.replay();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('returns the same handle on every render', () => {
    const { result, rerender } = renderHook(
      ({ done }: { done: boolean | undefined }) => useTutorial('employer_messages', { done }),
      { initialProps: { done: undefined } as { done: boolean | undefined } },
    );
    const first = result.current;

    rerender({ done: true });

    expect(result.current).toBe(first);
  });
});

describe('provider and overlay placeholders', () => {
  it('render their children unchanged', () => {
    render(
      <OverlayPresenceProvider>
        <TutorialProgressProvider>
          <p>shell content</p>
        </TutorialProgressProvider>
      </OverlayPresenceProvider>,
    );

    expect(screen.getByText('shell content')).toBeInTheDocument();
  });

  it('useOverlayPresence accepts either state and does nothing', () => {
    const { rerender, result } = renderHook(({ open }: { open: boolean }) => useOverlayPresence(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });

    expect(result.current).toBeUndefined();
  });
});

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

  it.each(CONTENT)('%s exports its own id, role and namespace', (file, definition, role) => {
    expect(definition.id).toBe(file.replace(/-/g, '_'));
    expect(definition.role).toBe(role);
    expect(definition.namespace).toBe(`tutorial.${definition.id}`);
  });

  it.each(CONTENT)('%s has one slide whose scene renders nothing', (_file, definition) => {
    expect(definition.slides).toHaveLength(1);
    const { Scene } = definition.slides[0];

    const { container } = render(<Scene still={false} />);

    expect(container).toBeEmptyDOMElement();
  });
});
