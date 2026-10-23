import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialId } from '@/lib/api/tutorials';
import { resetHarness, tutorialCalls, watchDialogs } from './harness';
import { HostPage, Providers, posts, readyEmployer, settle, type HostSnapshot } from './pages';

/*
 * The settle check no longer reads the registry (it lives in the player's
 * chunk). A tutorial with no slides, which `registry.test.ts` rules out for
 * the real content, still never leaves a play hanging with nothing on
 * screen: it ends at once, records nothing, and its host opens.
 */

vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
vi.mock('@/i18n/navigation', async () => ({ usePathname: (await import('./harness')).usePathnameMock }));
vi.mock('@/lib/api', async () => {
    const harness = await import('./harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});
vi.mock('@/lib/tutorials/registry', async () => {
    const { FIXTURE_REGISTRY } = await import('@/components/tutorials/__tests__/fixtures');
    const registry = { ...FIXTURE_REGISTRY, employer_post_job: { ...FIXTURE_REGISTRY.employer_post_job, slides: [] } };
    return {
        TUTORIALS: registry,
        getTutorial: (id: TutorialId) => registry[id],
        tutorialsForRole: (role: string) => Object.values(registry).filter((item) => item.role === role),
    };
});

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
});

describe('a tutorial with no slides', () => {
    it('ends at once: nothing shows, nothing is recorded, and the host opens', async () => {
        readyEmployer();
        const snapshots: HostSnapshot[] = [];
        render(<HostPage onHostOpen={(snapshot) => snapshots.push(snapshot)} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        const watch = watchDialogs();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(snapshots).toHaveLength(1));
        await settle();

        watch.stop();
        expect(watch.most()).toBe(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        expect(posts()).toEqual([]);
    });
});
