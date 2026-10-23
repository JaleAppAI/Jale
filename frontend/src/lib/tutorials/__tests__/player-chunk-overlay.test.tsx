import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialId } from '@/lib/api/tutorials';
import type { TutorialHandle } from '../types';
import { resetHarness, tutorialCalls } from './harness';
import { AutoPage, OtherOverlay, Providers, dialogs, posts, readyEmployer, settle, tutorialDialog } from './pages';

/*
 * The overlay rule (R4) is checked when the player has ARRIVED, right before
 * its dialog would mount, not when the play was asked for: a dialog that
 * opened while the player was loading still turns an auto-open down.
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

describe('a dialog that opens while the player loads', () => {
    it('turns the auto-open down when the player arrives, for the rest of the page view', async () => {
        readyEmployer();
        let handle: TutorialHandle | null = null;
        function Page({ overlay }: { overlay: boolean }) {
            return (
                <>
                    <OtherOverlay open={overlay} />
                    <AutoPage done={false} onHandle={(value) => (handle = value)} />
                </>
            );
        }
        const view = render(<Page overlay={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await waitFor(() => expect(chunk.fetched).toHaveBeenCalledTimes(1));
        await settle();
        expect(dialogs()).toBe(0);

        view.rerender(<Page overlay />);
        await settle();
        chunk.open();
        await waitFor(() => expect(chunk.arrived).toHaveBeenCalledTimes(1));
        await settle();

        expect(tutorialDialog('employer_welcome')).toBeNull();
        expect(dialogs()).toBe(1);

        view.rerender(<Page overlay={false} />);
        await settle();
        expect(dialogs()).toBe(0);

        // The turned-down play is over, not still waiting: a replay plays at once.
        act(() => handle?.replay());
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        expect(posts()).toEqual([]);
    });
});
