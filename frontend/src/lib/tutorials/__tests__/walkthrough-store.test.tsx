import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import type { TutorialId, TutorialOutcome } from '@/lib/api/tutorials';
import { Modal } from '@/components/ui/modal';
import { FIXTURE_MESSAGES } from '@/components/tutorials/__tests__/fixtures';
import { OverlayPresenceProvider, useOverlayPresence } from '../overlay';
import { TutorialProgressProvider, type PlayMode } from '../progress';
import { useTutorial } from '../use-tutorial';
import type { TutorialHandle } from '../types';
import { record, resetHarness, route, signIn } from './harness';
import { recordPosts, serveTutorialsWithSettings } from './settings-harness';

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
 * The store's side of the step-by-step guides: a walkthrough play is drawn by
 * the guides' own chunk (`GuideHost`, a stand-in here that shows how it was
 * asked to play), `runWithHost` opens the host first and then queues the guide
 * INSIDE it (`inHost`: the overlay rule does not refuse it for that host, but
 * one play at a time still holds), and the recording rules are the slide
 * player's: auto records, always records only the first outcome, replay never.
 */

const guide = vi.hoisted(() => ({ plays: [] as Array<{ id: string; mode: PlayMode }> }));

vi.mock('@/components/tutorials/GuideHost', () => ({
    default: ({
        id,
        mode,
        onDismiss,
        onMute,
    }: {
        id: TutorialId;
        mode: PlayMode;
        onDismiss: (outcome: TutorialOutcome) => void;
        onMute: (id: TutorialId) => Promise<boolean>;
    }) => {
        guide.plays.push({ id, mode });
        return (
            <div role="dialog" aria-label="Guide" data-mode={mode}>
                <button type="button" onClick={() => onDismiss('completed')}>
                    Finish guide
                </button>
                <button type="button" onClick={() => onDismiss('skipped')}>
                    End guide
                </button>
                <button type="button" onClick={() => void onMute(id).then(() => onDismiss('skipped'))}>
                    Mute guide
                </button>
            </div>
        );
    },
}));

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
    await import('@/components/tutorials/TutorialHost');
    await import('@/components/tutorials/GuideHost');
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    guide.plays.length = 0;
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/employer/dashboard';
    signIn('employer');
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
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

const guideDialog = () => screen.queryByRole('dialog', { name: 'Guide' });
const hostDialog = () => screen.queryByRole('dialog', { name: 'Job form' });
const slides = () => screen.queryByRole('dialog', { name: 'Sample posting tour' });

/** The wizard's owner: "Post a job" opens the host and runs the guide inside it. */
function HostPage({
    done = false,
    replay = false,
    order,
    onHandle,
}: {
    done?: boolean;
    replay?: boolean;
    order?: string[];
    onHandle?: (handle: TutorialHandle) => void;
}) {
    const tutorial = useTutorial('employer_post_job', { done, walkthrough: true });
    onHandle?.(tutorial);
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    tutorial.runWithHost(
                        () => {
                            order?.push(`host opened, guide shown: ${guideDialog() !== null}`);
                            setOpen(true);
                        },
                        undefined,
                        { replay },
                    );
                    order?.push(`after the press, guide shown: ${guideDialog() !== null}`);
                }}
            >
                Post a job
            </button>
            <Modal open={open} onClose={() => setOpen(false)} title="Job form">
                <button type="button">Job title</button>
            </Modal>
        </>
    );
}

function OtherOverlay({ open }: { open: boolean }) {
    useOverlayPresence(open);
    return open ? <div role="dialog" aria-label="Other dialog" /> : null;
}

/** A page whose own task has a guide, auto-opened once ready. */
function AutoPage({ walkthrough }: { walkthrough: boolean }) {
    const tutorial = useTutorial('employer_post_job', { done: false, walkthrough });
    useEffect(() => {
        tutorial.maybeAutoOpen();
    }, [tutorial]);
    return <p>page</p>;
}

const press = () =>
    act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Post a job' }));
    });

describe('runWithHost', () => {
    it('without the provider, simply opens the host', () => {
        const openHost = vi.fn();
        const { result } = renderHook(() => useTutorial('employer_post_job', { done: false, walkthrough: true }));
        result.current.runWithHost(openHost);
        expect(openHost).toHaveBeenCalledTimes(1);
    });

    it('opens the host first, from the press, and then the guide inside it', async () => {
        serveTutorialsWithSettings();
        const order: string[] = [];
        render(
            <Providers>
                <HostPage order={order} />
            </Providers>,
        );
        await settle();

        press();
        expect(order).toEqual(['host opened, guide shown: false', 'after the press, guide shown: false']);
        expect(hostDialog()).not.toBeNull();
        expect(guideDialog()).toBeNull();

        await settle();
        // The host is an open overlay, and the guide still shows: it runs in the host.
        expect(hostDialog()).not.toBeNull();
        expect(guideDialog()).not.toBeNull();
        expect(guide.plays.at(-1)).toEqual({ id: 'employer_post_job', mode: 'auto' });
    });

    it('opens only the host when the guide may not auto-play', async () => {
        serveTutorialsWithSettings({ records: [record('employer_post_job', 'skipped')] });
        render(
            <Providers>
                <HostPage />
            </Providers>,
        );
        await settle();
        press();
        await settle();
        expect(hostDialog()).not.toBeNull();
        expect(guideDialog()).toBeNull();
        expect(guide.plays).toEqual([]);
    });

    it('opens only the host when another play is up: one play at a time still holds', async () => {
        serveTutorialsWithSettings();
        let handle: TutorialHandle | null = null;
        render(
            <Providers>
                <HostPage onHandle={(h) => (handle = h)} />
            </Providers>,
        );
        await settle();
        // The slides of the same task, replayed from Help, are up.
        act(() => {
            (handle as unknown as TutorialHandle).replay();
        });
        await settle();
        expect(slides()).not.toBeNull();

        press();
        await settle();
        expect(hostDialog()).not.toBeNull();
        expect(guide.plays).toEqual([]);
    });

    it('with `replay`, plays whatever the history, and records nothing', async () => {
        serveTutorialsWithSettings({ records: [record('employer_post_job', 'completed')] });
        render(
            <Providers>
                <HostPage done replay />
            </Providers>,
        );
        await settle();
        press();
        await settle();
        expect(guideDialog()).toHaveAttribute('data-mode', 'replay');
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Finish guide' }));
        });
        await settle();
        expect(guideDialog()).toBeNull();
        expect(recordPosts()).toEqual([]);
    });
});

describe('the overlay rule and walkthrough plays', () => {
    it('refuses a page’s own walkthrough under another overlay (only `inHost` is exempt)', async () => {
        serveTutorialsWithSettings();
        render(
            <Providers>
                <OtherOverlay open />
                <AutoPage walkthrough />
            </Providers>,
        );
        await settle();
        expect(guideDialog()).toBeNull();
        expect(guide.plays).toEqual([]);
    });

    it('maybeAutoOpen plays the guide where the page has one, and the slides where it has none', async () => {
        serveTutorialsWithSettings();
        const first = render(
            <Providers>
                <AutoPage walkthrough />
            </Providers>,
        );
        await settle();
        expect(guideDialog()).not.toBeNull();
        expect(slides()).toBeNull();
        first.unmount();

        resetHarness();
        signIn('employer');
        serveTutorialsWithSettings();
        render(
            <Providers>
                <AutoPage walkthrough={false} />
            </Providers>,
        );
        await settle();
        expect(slides()).not.toBeNull();
        expect(guideDialog()).toBeNull();
    });
});

describe('recording a walkthrough play', () => {
    it('an auto play records how it ended', async () => {
        serveTutorialsWithSettings();
        render(
            <Providers>
                <HostPage />
            </Providers>,
        );
        await settle();
        press();
        await settle();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
        });
        await settle();
        expect(recordPosts()).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);
        // The host stays open: ending the guide never closes it.
        expect(hostDialog()).not.toBeNull();
    });

    it('an "every time" play records only when the account has no outcome yet, and offers mute', async () => {
        const server = serveTutorialsWithSettings({
            records: [record('employer_post_job', 'skipped')],
            settings: { always_show: true, muted: [] },
        });
        render(
            <Providers>
                <HostPage done />
            </Providers>,
        );
        await settle();
        press();
        await settle();
        expect(guideDialog()).toHaveAttribute('data-mode', 'always');
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Mute guide' }));
        });
        await settle();
        expect(server.stored().muted).toEqual(['employer_post_job']);
        // It already had an outcome: the first one stands.
        expect(recordPosts()).toEqual([]);
    });
});
