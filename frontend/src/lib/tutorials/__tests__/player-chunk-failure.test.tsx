import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialId } from '@/lib/api/tutorials';
import { resetHarness, tutorialCalls } from './harness';
import { AutoPage, HostPage, Providers, dialogs, posts, readyEmployer, settle, type HostSnapshot } from './pages';

/*
 * When the player chunk cannot be fetched (a dropped connection), nothing
 * breaks: no tutorial shows, nothing is recorded, a "before the host" host
 * opens as if there were no tutorial, and the next play asks again.
 */

vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
vi.mock('@/i18n/navigation', async () => ({ usePathname: (await import('./harness')).usePathnameMock }));
vi.mock('@/lib/api', async () => {
    const harness = await import('./harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});
vi.mock('@/lib/tutorials/registry', async () => {
    const { FIXTURE_REGISTRY } = await import('@/components/tutorials/__tests__/fixtures');
    return {
        TUTORIALS: FIXTURE_REGISTRY,
        getTutorial: (id: TutorialId) => FIXTURE_REGISTRY[id],
        tutorialsForRole: (role: string) => Object.values(FIXTURE_REGISTRY).filter((item) => item.role === role),
    };
});
vi.mock('@/components/tutorials/TutorialHost', async () => {
    throw new Error('chunk unavailable');
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

describe('a player that cannot be fetched', () => {
    it('shows no tutorial, records nothing, and opens the host each time', async () => {
        readyEmployer();
        const snapshots: HostSnapshot[] = [];
        render(
            <>
                <AutoPage done={false} />
                <HostPage onHostOpen={(snapshot) => snapshots.push(snapshot)} />
            </>,
            { wrapper: Providers },
        );
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        expect(dialogs()).toBe(0);

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(snapshots).toHaveLength(1));
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        expect(dialogs()).toBe(1);

        fireEvent.keyDown(document, { key: 'Escape' });
        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(snapshots).toHaveLength(2));

        expect(dialogs()).toBe(1);
        expect(posts()).toEqual([]);
    });
});
