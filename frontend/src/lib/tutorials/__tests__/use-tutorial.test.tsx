import { StrictMode, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import type { TutorialId } from '@/lib/api/tutorials';
import { Modal } from '@/components/ui/modal';
import { FIXTURE_MESSAGES, titleOf } from '@/components/tutorials/__tests__/fixtures';
import { OverlayPresenceProvider, useOverlayPresence } from '../overlay';
import { TutorialProgressProvider } from '../progress';
import { useTutorial } from '../use-tutorial';
import type { TutorialHandle, TutorialSceneProps } from '../types';
import {
    apiFetch,
    jsonResponse,
    record,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    signOut,
    tutorialCalls,
    watchDialogs,
} from './harness';

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

/*
 * `useTutorial` (FE-1 §4.6, K1 and ruling R4): the auto-open gate, the
 * "before the host" play, replay, and the timing rules that keep exactly one
 * dialog on screen: the host opens only after the tutorial's dialog has gone,
 * from a post-commit effect, with the page scroll and focus handed back first.
 */

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

afterEach(() => {
    vi.restoreAllMocks();
});

const messages = { ...en, ...FIXTURE_MESSAGES.en };

function Providers({ children }: { children: ReactNode }) {
    return (
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>{children}</TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
}

async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const posts = () => tutorialCalls().filter(([method]) => method === 'POST');
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const tutorialDialog = (id: TutorialId) => screen.queryByRole('dialog', { name: titleOf(id) });

/** A page that auto-opens its tutorial once ready, as the dashboard will. */
function AutoPage({
    id = 'employer_welcome',
    done,
    vars,
    onHandle,
}: {
    id?: TutorialId;
    done: boolean | undefined;
    vars?: TutorialSceneProps['vars'];
    onHandle?: (handle: TutorialHandle) => void;
}) {
    const tutorial = useTutorial(id, { done });
    onHandle?.(tutorial);
    useEffect(() => {
        tutorial.maybeAutoOpen(vars);
    }, [tutorial, done, vars]);
    return <p>page</p>;
}

/** Another dialog on the page, such as the hire celebration. */
function OtherOverlay({ open }: { open: boolean }) {
    useOverlayPresence(open);
    return open ? <div role="dialog" aria-label="Other dialog" /> : null;
}

/** A host that opens its own dialog after the tutorial, as "Post a job" will. */
type HostSnapshot = { overflow: string; active: Element | null; dialogs: number };

function HostPage({
    done,
    onHostOpen,
}: {
    done: boolean | undefined;
    onHostOpen: (snapshot: HostSnapshot) => void;
}) {
    const tutorial = useTutorial('employer_post_job', { done });
    const [hostOpen, setHostOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() =>
                    tutorial.runBeforeHost(() => {
                        onHostOpen({
                            overflow: document.body.style.overflow,
                            active: document.activeElement,
                            dialogs: dialogs(),
                        });
                        setHostOpen(true);
                    })
                }
            >
                Post a job
            </button>
            <Modal open={hostOpen} onClose={() => setHostOpen(false)} title="Job form">
                <button type="button">Job title</button>
            </Modal>
        </>
    );
}


async function readyEmployer(records = [] as ReturnType<typeof record>[]) {
    route.path = '/employer/dashboard';
    signIn('employer');
    serveTutorials(records);
}

describe('auto-open gate', () => {
    it('opens a tutorial that has no record, for an account that has not done the task', async () => {
        await readyEmployer();

        render(<AutoPage done={false} />, { wrapper: Providers });

        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        expect(dialogs()).toBe(1);
    });

    it('holds a request made before the read lands, and opens once it does', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        const answer = deferred<Response>();
        apiFetch.mockReturnValue(answer.promise);

        render(<AutoPage done={false} />, { wrapper: Providers });
        await settle();
        expect(dialogs()).toBe(0);

        answer.resolve(jsonResponse(200, { tutorials: [] }));

        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
    });

    it('drops a held request when its page goes away before the read lands', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        const answer = deferred<Response>();
        apiFetch.mockReturnValue(answer.promise);
        function Shell({ showPage }: { showPage: boolean }) {
            return <>{showPage ? <AutoPage done={false} /> : <p>elsewhere</p>}</>;
        }
        const view = render(<Shell showPage />, { wrapper: Providers });
        await settle();

        view.rerender(<Shell showPage={false} />);
        answer.resolve(jsonResponse(200, { tutorials: [] }));
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('drops a held request when the read fails', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        const answer = deferred<Response>();
        apiFetch.mockReturnValue(answer.promise);
        render(<AutoPage done={false} />, { wrapper: Providers });
        await settle();

        answer.resolve(jsonResponse(500, { error: 'internal' }));
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('opens nothing after a failed read', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        serveTutorials({ status: 503 });
        let handle: TutorialHandle | null = null;
        render(<AutoPage done={false} onHandle={(value) => (handle = value)} />, { wrapper: Providers });
        await settle();

        act(() => handle?.maybeAutoOpen());
        await settle();

        expect(dialogs()).toBe(0);
    });

    it.each([
        ['still loading', undefined],
        ['already done', true],
    ])('opens nothing while "done" is %s', async (_label, done) => {
        await readyEmployer();

        render(<AutoPage done={done} />, { wrapper: Providers });
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('opens nothing for a tutorial this account already finished or skipped', async () => {
        await readyEmployer([record('employer_welcome', 'skipped')]);

        render(<AutoPage done={false} />, { wrapper: Providers });
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('opens nothing while another overlay is up, and does not try again in this page view', async () => {
        await readyEmployer();
        let handle: TutorialHandle | null = null;
        function Page({ overlay }: { overlay: boolean }) {
            return (
                <>
                    <OtherOverlay open={overlay} />
                    <AutoPage done={false} onHandle={(value) => (handle = value)} />
                </>
            );
        }
        const view = render(<Page overlay />, { wrapper: Providers });
        await settle();
        expect(tutorialDialog('employer_welcome')).toBeNull();

        view.rerender(<Page overlay={false} />);
        act(() => handle?.maybeAutoOpen());
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('stands down when an overlay opens in the same commit as the tutorial would', async () => {
        await readyEmployer();
        function Page() {
            const tutorial = useTutorial('employer_welcome', { done: false });
            const [overlay, setOverlay] = useState(false);
            return (
                <>
                    <OtherOverlay open={overlay} />
                    <button
                        type="button"
                        onClick={() => {
                            tutorial.maybeAutoOpen();
                            setOverlay(true);
                        }}
                    >
                        both
                    </button>
                </>
            );
        }
        render(<Page />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'both' }).click());
        await settle();

        expect(tutorialDialog('employer_welcome')).toBeNull();
        expect(dialogs()).toBe(1);
    });

    it('opens one tutorial at a time when two pages ask at once', async () => {
        await readyEmployer();

        render(
            <>
                <AutoPage id="employer_welcome" done={false} />
                <AutoPage id="employer_applicants" done={false} />
            </>,
            { wrapper: Providers },
        );
        await settle();
        await settle();

        expect(dialogs()).toBe(1);
    });

    it('opens once, and records once, under React’s development double effects', async () => {
        await readyEmployer();

        render(
            <StrictMode>
                <AutoPage done={false} />
            </StrictMode>,
            { wrapper: Providers },
        );
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        await settle();
        expect(dialogs()).toBe(1);

        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        expect(dialogs()).toBe(0);
        expect(posts()).toHaveLength(1);
    });

    it('opens nothing for a tutorial of the other role', async () => {
        await readyEmployer();

        render(<AutoPage id="worker_apply" done={false} />, { wrapper: Providers });
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('opens nothing for a signed-out visitor, and asks nothing', async () => {
        route.path = '/employer/dashboard';
        serveTutorials([]);

        render(<AutoPage done={false} />, { wrapper: Providers });
        await settle();

        expect(dialogs()).toBe(0);
        expect(tutorialCalls()).toEqual([]);
    });
});

describe('recording', () => {
    it('posts nothing on render, nor while the tutorial is up', async () => {
        await readyEmployer();

        render(<AutoPage done={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        await settle();

        expect(posts()).toEqual([]);
    });

    it('posts "completed" when an auto-opened tutorial is finished', async () => {
        await readyEmployer();
        render(<AutoPage done={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());

        act(() => screen.getByRole('button', { name: 'Next' }).click());
        act(() => screen.getByRole('button', { name: 'Next' }).click());
        act(() => screen.getByRole('button', { name: 'Got it' }).click());
        await settle();

        expect(posts()).toEqual([
            ['POST', '/employer/tutorials', { tutorial_id: 'employer_welcome', outcome: 'completed' }],
        ]);
        expect(dialogs()).toBe(0);
    });

    it.each([
        ['Skip', () => act(() => screen.getByRole('button', { name: 'Skip' }).click())],
        ['the close X', () => act(() => screen.getByRole('button', { name: 'Close' }).click())],
        ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
        [
            'a backdrop press',
            () => {
                const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
                fireEvent.mouseDown(backdrop);
                fireEvent.click(backdrop);
            },
        ],
    ])('posts "skipped" when an auto-opened tutorial is dismissed with %s', async (_way, dismiss) => {
        await readyEmployer();
        render(<AutoPage done={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());

        dismiss();
        await settle();

        expect(posts()).toEqual([
            ['POST', '/employer/tutorials', { tutorial_id: 'employer_welcome', outcome: 'skipped' }],
        ]);
    });

    it('does not open the same tutorial again on the next page after it was dismissed', async () => {
        await readyEmployer();
        function Shell({ page }: { page: number }) {
            return <AutoPage key={page} done={false} />;
        }
        const view = render(<Shell page={1} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        view.rerender(<Shell page={2} />);
        await settle();

        expect(dialogs()).toBe(0);
        expect(posts()).toHaveLength(1);
    });

    it('does not re-open in this browser session when the outcome failed to save', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        serveTutorials([], { status: 500, body: { error: 'internal' } });
        const first = render(<AutoPage done={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        first.unmount();

        // A reload in the same browser session: the server still has no record.
        render(<AutoPage done={false} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls().filter(([method]) => method === 'GET')).toHaveLength(2));
        await settle();

        expect(dialogs()).toBe(0);
        expect(posts()).toHaveLength(1);
    });

    it('never posts for a replay, even of a tutorial with a record', async () => {
        await readyEmployer([record('employer_welcome')]);
        let handle: TutorialHandle | null = null;
        render(<AutoPage done onHandle={(value) => (handle = value)} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => handle?.replay());
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        expect(posts()).toEqual([]);
    });

    it('replays after a failed read, too', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        serveTutorials({ status: 503 });
        let handle: TutorialHandle | null = null;
        render(<AutoPage done={false} onHandle={(value) => (handle = value)} />, { wrapper: Providers });
        await settle();

        act(() => handle?.replay());

        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
    });

    it('replays with the vars the host last gave', async () => {
        await readyEmployer([record('employer_welcome')]);
        let handle: TutorialHandle | null = null;
        render(<AutoPage done vars={{ limit: 15 }} onHandle={(value) => (handle = value)} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        const { sceneRenders } = await import('@/components/tutorials/__tests__/fixtures');
        sceneRenders.length = 0;
        act(() => handle?.replay());
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());

        expect(sceneRenders.at(-1)?.vars).toEqual({ limit: 15 });
    });
});

describe('runBeforeHost', () => {
    it('opens the host at once, with no tutorial, while the read is in flight', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        apiFetch.mockReturnValue(new Promise(() => {}));
        const onHostOpen = vi.fn();
        render(<HostPage done={false} onHostOpen={onHostOpen} />, { wrapper: Providers });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        expect(tutorialDialog('employer_post_job')).toBeNull();
    });

    it('opens the host at once for an account with a record, or one that has done the task', async () => {
        await readyEmployer([record('employer_post_job')]);
        const onHostOpen = vi.fn();
        render(<HostPage done={false} onHostOpen={onHostOpen} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(tutorialDialog('employer_post_job')).toBeNull();
    });

    it('plays the tutorial first and opens the host only after it closes', async () => {
        await readyEmployer();
        const onHostOpen = vi.fn();
        render(<HostPage done={false} onHostOpen={onHostOpen} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        expect(onHostOpen).not.toHaveBeenCalled();

        act(() => screen.getByRole('button', { name: 'Next' }).click());
        act(() => screen.getByRole('button', { name: 'Next' }).click());
        act(() => screen.getByRole('button', { name: 'Got it' }).click());
        await settle();

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        expect(posts()).toEqual([
            ['POST', '/employer/tutorials', { tutorial_id: 'employer_post_job', outcome: 'completed' }],
        ]);
    });

    it('opens the host after a skip as well', async () => {
        await readyEmployer();
        const onHostOpen = vi.fn();
        render(<HostPage done={false} onHostOpen={onHostOpen} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        fireEvent.keyDown(document, { key: 'Escape' });
        await settle();

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
    });

    it('hands the page back first: scroll unlocked and focus on the button when the host opens, then locked again', async () => {
        await readyEmployer();
        const snapshots: HostSnapshot[] = [];
        render(<HostPage done={false} onHostOpen={(snapshot) => snapshots.push(snapshot)} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        const opener = screen.getByRole('button', { name: 'Post a job' });
        opener.focus();

        act(() => opener.click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        expect(document.body.style.overflow).toBe('hidden');
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        expect(snapshots).toEqual([{ overflow: '', active: opener, dialogs: 0 }]);
        expect(document.body.style.overflow).toBe('hidden');

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.body.style.overflow).toBe('');
        expect(document.activeElement).toBe(opener);
    });

    it('never has two dialogs in the page at once', async () => {
        await readyEmployer();
        render(<HostPage done={false} onHostOpen={() => {}} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        const watch = watchDialogs();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        watch.stop();

        expect(watch.most()).toBe(1);
    });

    it('opens the host at once when another overlay is up', async () => {
        await readyEmployer();
        const onHostOpen = vi.fn();
        render(
            <>
                <OtherOverlay open />
                <HostPage done={false} onHostOpen={onHostOpen} />
            </>,
            { wrapper: Providers },
        );
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await settle();

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(tutorialDialog('employer_post_job')).toBeNull();
    });
});

describe('the handle', () => {
    it('is the same object on every render', async () => {
        await readyEmployer();
        const { result, rerender } = renderHook(
            ({ done }: { done: boolean | undefined }) => useTutorial('employer_messages', { done }),
            { initialProps: { done: undefined } as { done: boolean | undefined }, wrapper: Providers },
        );
        const first = result.current;
        await settle();

        rerender({ done: true });
        await settle();

        expect(result.current).toBe(first);
    });

    it('uses the latest "done" without changing identity', async () => {
        await readyEmployer();
        let handle: TutorialHandle | null = null;
        const keep = (value: TutorialHandle) => {
            handle = value;
        };
        function Page({ done, onHandle }: { done: boolean | undefined; onHandle: (value: TutorialHandle) => void }) {
            onHandle(useTutorial('employer_welcome', { done }));
            return null;
        }
        const view = render(<Page done={undefined} onHandle={keep} />, { wrapper: Providers });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        const first = handle;

        view.rerender(<Page done={false} onHandle={keep} />);
        act(() => handle?.maybeAutoOpen());

        expect(handle).toBe(first);
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
    });
});

describe('public pages and signed-out visitors', () => {
    /** Every way a page can reach the hooks: auto-open, before a host, and a replay dismissed. */
    function EveryCall() {
        const tutorial = useTutorial('employer_welcome', { done: false });
        const [hostOpen, setHostOpen] = useState(false);
        useEffect(() => {
            tutorial.maybeAutoOpen();
        }, [tutorial]);
        return (
            <>
                <button type="button" onClick={() => tutorial.runBeforeHost(() => setHostOpen(true))}>
                    Host
                </button>
                <button type="button" onClick={() => tutorial.replay()}>
                    Replay
                </button>
                {hostOpen ? <p>host open</p> : null}
            </>
        );
    }

    it.each([
        ['/', false],
        ['/j/AB12CD', false],
        ['/auth/employer', false],
        ['/', true],
        ['/j/AB12CD', true],
        ['/auth/employer', true],
    ])('make no tutorial request on %s (signed in: %s)', async (path, signedIn) => {
        route.path = path;
        if (signedIn) signIn('employer');
        else signOut();
        serveTutorials([]);

        render(<EveryCall />, { wrapper: Providers });
        await settle();
        act(() => screen.getByRole('button', { name: 'Host' }).click());
        expect(screen.getByText('host open')).toBeInTheDocument();
        act(() => screen.getByRole('button', { name: 'Replay' }).click());
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();

        expect(tutorialCalls()).toEqual([]);
        expect(apiFetch).not.toHaveBeenCalled();
    });
});

describe('the dialog watch used above', () => {
    it('catches a second dialog that comes and goes inside one act', () => {
        function Flicker() {
            const [first, setFirst] = useState(false);
            const [second, setSecond] = useState(false);
            return (
                <>
                    <button
                        type="button"
                        onClick={() => {
                            flushSync(() => setFirst(true));
                            flushSync(() => setSecond(true));
                            flushSync(() => setSecond(false));
                        }}
                    >
                        flicker
                    </button>
                    {first ? <div role="dialog" aria-label="first" /> : null}
                    {second ? <div role="dialog" aria-label="second" /> : null}
                </>
            );
        }
        render(<Flicker />);
        const watch = watchDialogs();

        act(() => screen.getByRole('button', { name: 'flicker' }).click());
        const most = watch.most();
        watch.stop();

        expect(dialogs()).toBe(1);
        expect(most).toBe(2);
    });
});

describe('without a provider', () => {
    it('is inert: the host opens at once, and nothing else happens', () => {
        const { result } = renderHook(() => useTutorial('employer_post_job', { done: false }));
        const openHost = vi.fn();

        result.current.runBeforeHost(openHost);
        result.current.maybeAutoOpen({ limit: 1 });
        result.current.replay();

        expect(openHost).toHaveBeenCalledTimes(1);
        expect(openHost).toHaveBeenCalledWith();
        expect(dialogs()).toBe(0);
        expect(apiFetch).not.toHaveBeenCalled();
    });
});
