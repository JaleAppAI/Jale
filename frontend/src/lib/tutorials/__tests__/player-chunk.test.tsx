import { act, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialId } from '@/lib/api/tutorials';
import { resetHarness, route, serveTutorials, signIn, tutorialCalls, watchDialogs } from './harness';
import { AutoPage, HostPage, Providers, dialogs, posts, settle, tutorialDialog, type HostSnapshot } from './pages';

/*
 * The player and the tutorials' content are their own chunk (ruling on the
 * FE-1 review, S2): fetched only once a tutorial may play, never on a public
 * page. While it is on its way a play waits, unseen, and the R4 rules still
 * hold: one dialog at a time, and a "before the host" host opens only after
 * the tutorial has gone.
 *
 * The chunk is held back by a gate this suite opens, so the single test below
 * sees it loading and then arriving. It must stay the only test that opens the
 * gate: once the chunk is in, it stays in for the rest of the file.
 */

const chunk = vi.hoisted(() => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { fetched: vi.fn(), gate, open: () => release() };
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
    return importOriginal();
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

describe('the player chunk', () => {
    it('is fetched only where a tutorial may play; a play accepted while it loads shows once it arrives, alone, before its host', async () => {
        signIn('employer');
        serveTutorials([]);
        route.path = '/';
        const snapshots: HostSnapshot[] = [];
        function App({ dashboard }: { dashboard: boolean }) {
            return (
                <>
                    {dashboard ? <AutoPage done={false} /> : null}
                    <HostPage onHostOpen={(snapshot) => snapshots.push(snapshot)} />
                </>
            );
        }
        const view = render(<App dashboard={false} />, { wrapper: Providers });
        await settle();

        // A public page, signed in: nothing read, and no player fetched.
        expect(tutorialCalls()).toEqual([]);
        expect(chunk.fetched).not.toHaveBeenCalled();

        // A shell page: the read succeeds, so a tutorial may play here. The
        // player is fetched ahead of any play.
        route.path = '/employer/applicants';
        view.rerender(<App dashboard={false} />);
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await waitFor(() => expect(chunk.fetched).toHaveBeenCalledTimes(1));

        // The dashboard's auto-open waits for the player, unseen.
        route.path = '/employer/dashboard';
        view.rerender(<App dashboard />);
        await settle();
        expect(dialogs()).toBe(0);

        // The person leaves the dashboard before the player arrives: its
        // tutorial goes with it.
        view.rerender(<App dashboard={false} />);
        await settle();

        // "Post a job" while the player is still loading: the tutorial is
        // accepted, so the host waits; nothing is on screen yet.
        const watch = watchDialogs();
        const opener = screen.getByRole('button', { name: 'Post a job' });
        opener.focus();
        act(() => opener.click());
        await settle();
        expect(snapshots).toEqual([]);
        expect(dialogs()).toBe(0);

        chunk.open();

        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        expect(tutorialDialog('employer_welcome')).toBeNull();
        expect(snapshots).toEqual([]);

        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        expect(snapshots).toEqual([{ overflow: '', active: opener, dialogs: 0 }]);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        watch.stop();
        expect(watch.most()).toBe(1);
        expect(posts()).toEqual([
            ['POST', '/employer/tutorials', { tutorial_id: 'employer_post_job', outcome: 'skipped' }],
        ]);
    });
});
