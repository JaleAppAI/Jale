import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { act, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { TutorialId } from '@/lib/api/tutorials';
import { Modal } from '@/components/ui/modal';
import { FIXTURE_MESSAGES, titleOf } from '@/components/tutorials/__tests__/fixtures';
import { OverlayPresenceProvider, useOverlayPresence } from '../overlay';
import { TutorialProgressProvider } from '../progress';
import { useTutorial } from '../use-tutorial';
import type { TutorialHandle } from '../types';
import { route, serveTutorials, signIn, tutorialCalls } from './harness';

/*
 * The pages the player-chunk suites drive: the providers as the app layout
 * mounts them, a page that auto-opens its tutorial, a "before the host" page
 * and another dialog. Each suite mocks the modules it needs itself.
 */

const messages = { ...en, ...FIXTURE_MESSAGES.en };

export function Providers({ children }: { children: ReactNode }) {
    return (
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>{children}</TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
}

/** Two separate acts: the second commits whatever the first one's promises woke up. */
export async function settle() {
    for (let turn = 0; turn < 2; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

export const posts = () => tutorialCalls().filter(([method]) => method === 'POST');
export const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
export const tutorialDialog = (id: TutorialId) => screen.queryByRole('dialog', { name: titleOf(id) });

export function readyEmployer() {
    route.path = '/employer/dashboard';
    signIn('employer');
    serveTutorials([]);
}

/** A page that auto-opens its tutorial once ready, as the dashboard does. */
export function AutoPage({
    id = 'employer_welcome',
    done,
    onHandle,
}: {
    id?: TutorialId;
    done: boolean | undefined;
    onHandle?: (handle: TutorialHandle) => void;
}) {
    const tutorial = useTutorial(id, { done });
    onHandle?.(tutorial);
    useEffect(() => {
        tutorial.maybeAutoOpen();
    }, [tutorial, done]);
    return <p>page</p>;
}

/** Another dialog on the page, such as the hire celebration. */
export function OtherOverlay({ open }: { open: boolean }) {
    useOverlayPresence(open);
    return open ? <div role="dialog" aria-label="Other dialog" /> : null;
}

export type HostSnapshot = { overflow: string; active: Element | null; dialogs: number };

/** A host that opens its own dialog after the tutorial, as "Post a job" does. */
export function HostPage({ onHostOpen }: { onHostOpen: (snapshot: HostSnapshot) => void }) {
    const tutorial = useTutorial('employer_post_job', { done: false });
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
