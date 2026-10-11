import * as React from 'react';
import { useRef, useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import userEvent from '@testing-library/user-event';

import { Sheet, SheetBody, SheetFooter } from '../sheet';

/*
 * jsdom does no layout, so every element reports zero client rects -- which is
 * exactly what the sheet's "is this focusable thing actually rendered?" filter
 * reads to skip `display: none` stops. One rect per element puts the whole
 * tree back in the tab cycle for these tests.
 */
let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi
        .spyOn(Element.prototype, 'getClientRects')
        .mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

function Harness({
    onClose,
    closeOnBackdrop,
    withInitialFocus = false,
}: {
    onClose?: () => void;
    closeOnBackdrop?: boolean;
    withInitialFocus?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const fieldRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open sheet
            </button>
            <a href="#behind">Behind the sheet</a>
            <Sheet
                open={open}
                onClose={() => {
                    onClose?.();
                    setOpen(false);
                }}
                title="Report a problem"
                closeLabel="Close"
                closeOnBackdrop={closeOnBackdrop}
                initialFocusRef={withInitialFocus ? fieldRef : undefined}
            >
                <SheetBody>
                    <label>
                        First field
                        <input ref={fieldRef} />
                    </label>
                    <button type="button">Middle action</button>
                </SheetBody>
                <SheetFooter>
                    <button type="button">Last action</button>
                </SheetFooter>
            </Sheet>
        </>
    );
}

async function openSheet(props: Parameters<typeof Harness>[0] = {}) {
    const user = userEvent.setup();
    render(<Harness {...props} />);
    const opener = screen.getByRole('button', { name: 'Open sheet' });
    await user.click(opener);
    return { user, opener, dialog: screen.getByRole('dialog', { name: 'Report a problem' }) };
}

describe('Sheet', () => {
    it('renders nothing while closed', () => {
        render(<Harness />);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('is a modal dialog named by its title, with a named Close button', async () => {
        const { dialog } = await openSheet();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('heading', { name: 'Report a problem' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('moves focus into the sheet when it opens', async () => {
        const { dialog } = await openSheet();
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('honours an initial focus target', async () => {
        await openSheet({ withInitialFocus: true });
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'First field' }));
    });

    it('keeps Tab and Shift+Tab inside the sheet', async () => {
        const { user } = await openSheet();
        const close = screen.getByRole('button', { name: 'Close' });
        const last = screen.getByRole('button', { name: 'Last action' });

        last.focus();
        await user.tab();
        expect(document.activeElement).toBe(close);

        await user.tab({ shift: true });
        expect(document.activeElement).toBe(last);
    });

    it('closes on Escape', async () => {
        const onClose = vi.fn();
        const { user } = await openSheet({ onClose });
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes from the Close button', async () => {
        const onClose = vi.fn();
        const { user } = await openSheet({ onClose });
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('returns focus to the control that opened it', async () => {
        const { user, opener } = await openSheet();
        await user.keyboard('{Escape}');
        expect(document.activeElement).toBe(opener);
    });

    it('locks the page scroll while open and restores it after', async () => {
        document.body.style.overflow = 'auto';
        const { user } = await openSheet();
        expect(document.body.style.overflow).toBe('hidden');
        await user.keyboard('{Escape}');
        expect(document.body.style.overflow).toBe('auto');
        document.body.style.overflow = '';
    });

    it('is portaled to the body and excluded from screen captures, backdrop included', async () => {
        const { dialog } = await openSheet();
        const root = dialog.closest('[data-capture-exclude]');
        expect(root).not.toBeNull();
        // The excluded root is the backdrop itself, so one marker covers the
        // scrim AND the panel: a capture never draws either.
        expect(root!.parentElement).toBe(document.body);
        expect(root).not.toBe(dialog);
    });

    it('closes on a backdrop press, but not on a press inside the panel', async () => {
        const onClose = vi.fn();
        const { dialog } = await openSheet({ onClose });
        const backdrop = dialog.closest('[data-capture-exclude]')!;

        fireEvent.mouseDown(dialog);
        fireEvent.click(dialog);
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores the backdrop when asked to', async () => {
        const onClose = vi.fn();
        const { dialog } = await openSheet({ onClose, closeOnBackdrop: false });
        const backdrop = dialog.closest('[data-capture-exclude]')!;
        fireEvent.mouseDown(backdrop);
        fireEvent.click(backdrop);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('is a bottom sheet on phones and a right-hand panel from 640px, on the modal layer', async () => {
        const { dialog } = await openSheet();
        const backdrop = dialog.closest('[data-capture-exclude]') as HTMLElement;
        // CSS-only behaviour, so the classes are the honest assertion: jsdom
        // does no layout.
        expect(backdrop.className).toContain('z-50');
        expect(backdrop.className).toContain('items-end');
        expect(backdrop.className).toContain('sm:justify-end');
        expect(dialog.className).toContain('rounded-t-[var(--radius-card)]');
        expect(dialog.className).toContain('sm:h-full');
        // The shared entry animation, which globals.css switches off under
        // prefers-reduced-motion.
        expect(dialog.className).toContain('anim-fade-in');
    });
});

describe('Sheet across server render and hydration', () => {
    function Page() {
        return (
            <div>
                <p>page</p>
                <Sheet open onClose={() => {}} title="Fake title" closeLabel="Close">
                    <SheetBody>fake body</SheetBody>
                </Sheet>
            </div>
        );
    }

    it('renders nothing on the server, hydrates without a mismatch, then portals in', async () => {
        const html = renderToString(<Page />);
        expect(html).toBe('<div><p>page</p></div>');

        const container = document.createElement('div');
        container.innerHTML = html;
        document.body.appendChild(container);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const recoverable: unknown[] = [];

        let root: ReturnType<typeof hydrateRoot> | null = null;
        await act(async () => {
            root = hydrateRoot(container, <Page />, { onRecoverableError: (error) => recoverable.push(error) });
        });

        // The hydrated markup is the server's; the dialog lives in a portal on the body.
        expect(container.innerHTML).toBe('<div><p>page</p></div>');
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(recoverable).toEqual([]);
        expect(errors).not.toHaveBeenCalled();

        errors.mockRestore();
        act(() => root?.unmount());
        container.remove();
    });
});
