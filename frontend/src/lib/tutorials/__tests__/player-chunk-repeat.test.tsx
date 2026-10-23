import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialId } from '@/lib/api/tutorials';
import { resetHarness, tutorialCalls } from './harness';
import { HostPage, Providers, dialogs, posts, readyEmployer, settle, tutorialDialog, type HostSnapshot } from './pages';

/*
 * A second press of a "before the host" button while the player is still on
 * its way (nothing is on screen yet, so the person presses again) opens the
 * host at once, and the first press's tutorial is dropped: when the player
 * arrives it must not open the host a second time, or show over it.
 *
 * The chunk is held back by a gate; the single test below opens it, and must
 * stay the only one that does.
 */

const chunk = vi.hoisted(() => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { fetched: vi.fn(), arrived: vi.fn(), gate, open: () => release() };
});

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
vi.mock('@/components/tutorials/TutorialHost', async (importOriginal) => {
    chunk.fetched();
    await chunk.gate;
    const loaded = await importOriginal();
    chunk.arrived();
    return loaded;
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

describe('pressing a host button again while the player loads', () => {
    it('opens the host once, at the second press, and nothing more when the player arrives', async () => {
        readyEmployer();
        const snapshots: HostSnapshot[] = [];
        render(<HostPage onHostOpen={(snapshot) => snapshots.push(snapshot)} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await waitFor(() => expect(chunk.fetched).toHaveBeenCalledTimes(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await settle();
        expect(snapshots).toHaveLength(0);

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await settle();
        expect(snapshots).toHaveLength(1);

        chunk.open();
        await waitFor(() => expect(chunk.arrived).toHaveBeenCalledTimes(1));
        await settle();

        expect(snapshots).toHaveLength(1);
        expect(tutorialDialog('employer_post_job')).toBeNull();
        expect(dialogs()).toBe(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        expect(posts()).toEqual([]);
    });
});
