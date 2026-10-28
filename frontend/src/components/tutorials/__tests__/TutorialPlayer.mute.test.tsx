import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { ToastProvider } from '@/components/ui/toast';
import type { PlayMode } from '@/lib/tutorials/progress';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import { TutorialPlayer } from '../TutorialPlayer';
import { FIXTURE_MESSAGES, FIXTURE_REGISTRY } from './fixtures';

/*
 * The player's "Don't show this again" (K1-v2): only in a guide shown because
 * of the "every time" setting. It turns the guide off, closes it as a skip,
 * and tells the person where to turn it back on.
 */

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

const MUTE = 'Don’t show this again';

function play({
    definition = FIXTURE_REGISTRY.employer_post_job,
    mode,
    onMute,
    locale = 'en',
}: {
    definition?: TutorialDefinition;
    mode?: PlayMode;
    onMute?: () => Promise<boolean>;
    locale?: 'en' | 'es';
}) {
    const onDismiss = vi.fn();
    const messages = { ...(locale === 'en' ? en : es), ...FIXTURE_MESSAGES[locale] };
    render(
        <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
            <ToastProvider>
                <TutorialPlayer definition={definition} mode={mode} onMute={onMute} onDismiss={onDismiss} />
            </ToastProvider>
        </NextIntlClientProvider>,
    );
    return { onDismiss };
}

describe('"Don’t show this again" in the player', () => {
    it.each([['auto'], ['replay'], [undefined]] as const)('is not there in a %s play', (mode) => {
        play({ mode, onMute: vi.fn(async () => true) });

        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: MUTE })).toBeNull();
    });

    it('is there in an "every time" play, on every slide', () => {
        play({ mode: 'always', onMute: vi.fn(async () => true) });

        expect(screen.getByRole('button', { name: MUTE })).toBeInTheDocument();
        act(() => screen.getByRole('button', { name: 'Next' }).click());
        act(() => screen.getByRole('button', { name: 'Next' }).click());
        expect(screen.getByRole('button', { name: MUTE })).toBeInTheDocument();
    });

    it('turns the guide off, closes it once as a skip, and says where to turn it back on', async () => {
        const onMute = vi.fn(async () => true);
        const { onDismiss } = play({ mode: 'always', onMute });

        await act(async () => screen.getByRole('button', { name: MUTE }).click());

        expect(onMute).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(screen.getByText('Turned off. You can turn it back on in Help.')).toBeInTheDocument();
        expect(screen.queryByText('Couldn’t save that. Try again.')).toBeNull();
    });

    it('says so when the change was not saved', async () => {
        const { onDismiss } = play({ mode: 'always', onMute: vi.fn(async () => false) });

        await act(async () => screen.getByRole('button', { name: MUTE }).click());

        expect(onDismiss).toHaveBeenCalledWith('skipped');
        expect(screen.getByText('Couldn’t save that. Try again.')).toBeInTheDocument();
    });

    it.each([
        [FIXTURE_REGISTRY.employer_post_job, 'Guía apagada. Puede volver a activarla en Ayuda.'],
        [FIXTURE_REGISTRY.worker_apply, 'Guía apagada. Puedes volver a activarla en Ayuda.'],
    ])('speaks the role’s Spanish', async (definition, notice) => {
        play({ definition, mode: 'always', onMute: vi.fn(async () => true), locale: 'es' });

        await act(async () => screen.getByRole('button', { name: 'No volver a mostrar' }).click());

        expect(screen.getByText(notice)).toBeInTheDocument();
    });
});
