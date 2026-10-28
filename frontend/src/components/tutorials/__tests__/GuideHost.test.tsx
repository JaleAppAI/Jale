import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialId } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import type { PlayMode } from '@/lib/tutorials/progress';
import { Modal } from '@/components/ui/modal';
import { ToastProvider } from '@/components/ui/toast';
import { DIALOG_NOTICE_TTL_MS } from '../DialogNotice';
import GuideHost from '../GuideHost';

/*
 * The flow lanes fill in the other tasks' guides, so "a task with no guide"
 * is a registry that says so, not a real id that happens to be empty today.
 */
const NO_GUIDE: TutorialId = 'worker_apply';
vi.mock('../guides/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../guides/registry')>();
    return { ...actual, getGuide: (id: TutorialId) => (id === NO_GUIDE ? null : actual.getGuide(id)) };
});

/*
 * The guides' chunk: the task's guide from the registry, drawn by the
 * spotlight engine with the shared intro in the role's own voice. "Don't show
 * this again" is offered only in an "every time" play, as in the slide player,
 * and says where to turn the guide back on. A task with no guide is
 * unavailable: nothing drawn, no outcome.
 */

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());
afterEach(() => {
    vi.useRealTimers();
});

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Moves fake time on, letting React and the page watchers catch up. */
async function wait(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

/**
 * An "every time" play of the post-job guide inside a real `Modal`, as the
 * wizard holds it. The guide is drawn until it ends, as the progress
 * provider draws a play.
 */
function renderInWizard({ saved = true }: { saved?: boolean } = {}) {
    const onMute = vi.fn(async () => saved);
    function Wizard() {
        const [playing, setPlaying] = useState(true);
        return (
            <>
                <Modal open onClose={() => {}} title="Post a Job" data-guide="post.wizard" footer={<button type="button">Next</button>}>
                    <div data-guide="post.title">
                        <input aria-label="Job title" />
                    </div>
                </Modal>
                {playing ? (
                    <GuideHost
                        id="employer_post_job"
                        mode="always"
                        onMute={onMute}
                        onDismiss={() => setPlaying(false)}
                        onUnavailable={() => {}}
                    />
                ) : null}
            </>
        );
    }
    render(
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            <OverlayPresenceProvider>
                <ToastProvider>
                    <Wizard />
                </ToastProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
    return { onMute, wizard: () => screen.getByRole('dialog', { name: 'Post a Job' }) };
}

function renderHost({ id = 'employer_post_job', mode = 'auto', locale = 'en' }: { id?: TutorialId; mode?: PlayMode; locale?: 'en' | 'es' } = {}) {
    const onDismiss = vi.fn();
    const onUnavailable = vi.fn();
    const onMute = vi.fn(async () => true);
    render(
        <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : es} onError={() => {}}>
            <OverlayPresenceProvider>
                <ToastProvider>
                    {/* The post-job guide's first control, as the wizard marks it. */}
                    <div data-guide="post.title">
                        <input aria-label="Job title" />
                    </div>
                    <GuideHost id={id} mode={mode} onMute={onMute} onDismiss={onDismiss} onUnavailable={onUnavailable} />
                </ToastProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
    return { onDismiss, onUnavailable, onMute };
}

const MUTE = en.tutorial.help_center.mute;

describe('GuideHost', () => {
    it.each([['auto'], ['replay']] as const)('opens the guide’s intro with no mute in a %s play', async (mode) => {
        renderHost({ mode });
        await flush();
        expect(screen.getByRole('dialog', { name: en.tutorial.employer_post_job.guide.intro_title })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Guide me' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'I’ll do it myself' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: MUTE })).toBeNull();
    });

    it('offers "Don’t show this again" in an "every time" play: it mutes, says where to undo it, and ends as skipped', async () => {
        const { onMute, onDismiss } = renderHost({ mode: 'always' });
        await flush();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: MUTE }));
        });
        expect(onMute).toHaveBeenCalledWith('employer_post_job');
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(screen.getByText(en.tutorial.help_center.employer.muted_toast)).toBeInTheDocument();
    });

    it('speaks usted to the employer in Spanish', async () => {
        renderHost({ locale: 'es' });
        await flush();
        expect(screen.getByRole('button', { name: 'Guíeme' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Lo hago por mi cuenta' })).toBeInTheDocument();
    });

    it('says so in a toast on the page, outside any dialog', async () => {
        renderHost({ mode: 'always' });
        await flush();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: MUTE }));
        });
        const message = screen.getByText(en.tutorial.help_center.employer.muted_toast);
        expect(message.closest('[role="dialog"]')).toBeNull();
        expect(document.querySelector('[data-dialog-notice]')).toBeNull();
    });

    it('in a dialog, says so inside the dialog, on top of it, for the toast’s time', async () => {
        vi.useFakeTimers();
        const { onMute, wizard } = renderInWizard();
        await wait(0);
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: MUTE }));
        });
        await wait(100);
        expect(onMute).toHaveBeenCalledWith('employer_post_job');
        // The guide has ended; the wizard is still up, with the message in it.
        expect(screen.queryByRole('button', { name: MUTE })).toBeNull();
        const status = within(wizard()).getByRole('status');
        expect(status).toHaveTextContent(en.tutorial.help_center.employer.muted_toast);
        // Once, and not as a toast under the wizard's backdrop.
        expect(screen.getAllByText(en.tutorial.help_center.employer.muted_toast)).toHaveLength(1);
        expect(within(status).getByRole('button', { name: en.common.feedback.dismiss })).toBeInTheDocument();

        await wait(DIALOG_NOTICE_TTL_MS);
        expect(screen.queryByText(en.tutorial.help_center.employer.muted_toast)).toBeNull();
        expect(document.querySelector('[data-dialog-notice]')).toBeNull();
        expect(wizard()).toBeInTheDocument();
    });

    it('in a dialog, a save that failed says so there too, as an alert', async () => {
        vi.useFakeTimers();
        const { wizard } = renderInWizard({ saved: false });
        await wait(0);
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: MUTE }));
        });
        // The save settles, then the message in its place is read out.
        await wait(0);
        await wait(100);
        const alert = within(wizard()).getByRole('alert');
        expect(alert).toHaveTextContent(en.tutorial.help_center.employer.save_failed);
        expect(screen.queryByText(en.tutorial.help_center.employer.muted_toast)).toBeNull();
    });

    it('is over at once, with no outcome, when the wizard closes before its first field shows', async () => {
        const onUnavailable = vi.fn();
        const onDismiss = vi.fn();
        const view = (open: boolean) => (
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                <OverlayPresenceProvider>
                    <ToastProvider>
                        {open ? <div data-guide="post.wizard">Loading</div> : null}
                        <GuideHost
                            id="employer_post_job"
                            mode="auto"
                            onMute={async () => true}
                            onDismiss={onDismiss}
                            onUnavailable={onUnavailable}
                        />
                    </ToastProvider>
                </OverlayPresenceProvider>
            </NextIntlClientProvider>
        );
        const { rerender } = render(view(true));
        await flush();
        expect(onUnavailable).not.toHaveBeenCalled();
        rerender(view(false));
        await flush();
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('is unavailable for a task with no guide', async () => {
        const { onUnavailable, onDismiss } = renderHost({ id: NO_GUIDE });
        await flush();
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
