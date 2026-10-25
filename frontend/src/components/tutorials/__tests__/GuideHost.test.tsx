import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialId } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import type { PlayMode } from '@/lib/tutorials/progress';
import { ToastProvider } from '@/components/ui/toast';
import GuideHost from '../GuideHost';

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

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
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

    it('is unavailable for a task with no guide', async () => {
        const { onUnavailable, onDismiss } = renderHost({ id: 'worker_apply' });
        await flush();
        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onDismiss).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
