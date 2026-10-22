import { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { Modal } from '../modal';
import { Sheet, SheetBody } from '../sheet';
import { OverlayPresenceProvider, useOverlayRegistry, type OverlayRegistry } from '@/lib/tutorials/overlay';

/*
 * `Modal` and `Sheet` report themselves to the overlay coordinator, so a
 * tutorial never auto-opens on top of one. They are app-wide primitives, so
 * the first half of this suite pins that everything they already did is
 * unchanged -- open, close, Escape, focus in and back out, the scroll lock --
 * both with no coordinator mounted (every existing test and any tree outside
 * the app layout) and with one. The second half checks the report itself.
 */

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element puts the focusables back in
    // the primitives' "is it rendered?" filter.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

type Kind = 'Modal' | 'Sheet';

function Primitive({ kind, open, onClose }: { kind: Kind; open: boolean; onClose: () => void }) {
    if (kind === 'Modal') {
        return (
            <Modal open={open} onClose={onClose} title="Sample dialog">
                <button type="button">Inside action</button>
            </Modal>
        );
    }
    return (
        <Sheet open={open} onClose={onClose} title="Sample dialog" closeLabel="Close">
            <SheetBody>
                <button type="button">Inside action</button>
            </SheetBody>
        </Sheet>
    );
}

let registry: OverlayRegistry | null = null;

function keep(value: OverlayRegistry | null) {
    registry = value;
}

function RegistryProbe({ onValue = keep }: { onValue?: (value: OverlayRegistry | null) => void }) {
    onValue(useOverlayRegistry());
    return null;
}

function Harness({ kind, onClose }: { kind: Kind; onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open it
            </button>
            <Primitive
                kind={kind}
                open={open}
                onClose={() => {
                    onClose?.();
                    setOpen(false);
                }}
            />
        </>
    );
}

function renderHarness(kind: Kind, withProvider: boolean, onClose?: () => void) {
    const tree = <Harness kind={kind} onClose={onClose} />;
    return render(
        <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
            {withProvider ? (
                <OverlayPresenceProvider>
                    <RegistryProbe />
                    {tree}
                </OverlayPresenceProvider>
            ) : (
                tree
            )}
        </NextIntlClientProvider>,
    );
}

function openIt() {
    const opener = screen.getByRole('button', { name: 'Open it' });
    opener.focus();
    act(() => opener.click());
    return opener;
}

const CASES: ReadonlyArray<[Kind, boolean]> = [
    ['Modal', false],
    ['Modal', true],
    ['Sheet', false],
    ['Sheet', true],
];

describe.each(CASES)('%s (coordinator mounted: %s) behaves as before', (kind, withProvider) => {
    it('renders nothing while closed and opens a labelled dialog', () => {
        renderHarness(kind, withProvider);
        expect(screen.queryByRole('dialog')).toBeNull();

        openIt();

        expect(screen.getByRole('dialog', { name: 'Sample dialog' })).toBeInTheDocument();
    });

    it('moves focus in on open and hands it back to the opener on close', () => {
        renderHarness(kind, withProvider);
        const opener = openIt();
        const dialog = screen.getByRole('dialog');
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('closes on Escape, once', () => {
        const onClose = vi.fn();
        renderHarness(kind, withProvider, onClose);
        openIt();

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('locks the page scroll while open and restores it after', () => {
        document.body.style.overflow = '';
        renderHarness(kind, withProvider);

        openIt();
        expect(document.body.style.overflow).toBe('hidden');

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(document.body.style.overflow).toBe('');
    });

    it('closes from a press on the backdrop', () => {
        renderHarness(kind, withProvider);
        openIt();
        const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;

        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);

        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe.each(['Modal', 'Sheet'] as const)('%s reports its presence', (kind) => {
    it('is present while open and gone once closed', () => {
        renderHarness(kind, true);
        expect(registry?.isPresent()).toBe(false);

        openIt();
        expect(registry?.isPresent()).toBe(true);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(registry?.isPresent()).toBe(false);
    });

    it('is gone when it unmounts while open', () => {
        const view = render(
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                <OverlayPresenceProvider>
                    <RegistryProbe />
                    <Primitive kind={kind} open onClose={() => {}} />
                </OverlayPresenceProvider>
            </NextIntlClientProvider>,
        );
        expect(registry?.isPresent()).toBe(true);

        view.rerender(
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                <OverlayPresenceProvider>
                    <RegistryProbe />
                </OverlayPresenceProvider>
            </NextIntlClientProvider>,
        );
        expect(registry?.isPresent()).toBe(false);
    });
});
