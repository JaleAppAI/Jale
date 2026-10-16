'use client';

import * as React from 'react';
import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon';

/**
 * A sheet over the current screen: a bottom sheet on phones, a right-hand
 * panel from 640px up.
 *
 * It owes the user what `Modal` owes them, and borrows its patterns rather than
 * its component (Modal is a centred dialog and stays exactly as it is): focus
 * moves in on open and returns to the opener on close, Tab cannot leave the
 * panel, Escape and the Close button close it, and the page behind stops
 * scrolling. It sits on the same z-50 layer as Modal.
 *
 * Compose the inside with `SheetBody` (the scrolling region) and an optional
 * `SheetFooter` (pinned actions), so a caller that swaps its content -- a
 * multi-step form -- keeps one dialog, one title and one focus trap.
 *
 * The root carries `data-capture-exclude`. A sheet is never part of "the
 * screen you were on": an in-page capture drops the root with its subtree, so
 * neither the scrim nor the panel can end up in the picture, even when the
 * sheet opens while the capture is still running.
 */

const noSubscription = () => () => {};

/**
 * True once this render runs in the browser, where `document.body` exists to
 * portal into. A store read rather than an effect setting a flag (the same
 * pattern as `ReferredJobTicket`): the server render and the hydration pass
 * both read `false`, so they agree, and the client renders the portal right
 * after hydration with no extra state.
 */
function useInBrowser(): boolean {
    return useSyncExternalStore(noSubscription, () => true, () => false);
}

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'object',
    'embed',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
].join(',');

/**
 * Focusable descendants in DOM order, skipping anything not actually rendered
 * (`display: none`, a collapsed section), which would otherwise be a dead stop
 * in the tab cycle. Same rule as `Modal`.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true',
    );
}

export type SheetProps = {
    open: boolean;
    onClose: () => void;
    /** The dialog's visible heading, which is also its accessible name. */
    title: React.ReactNode;
    /** Accessible name of the Close button, from the caller's catalogue. */
    closeLabel: string;
    /**
     * Whether a press on the scrim closes the sheet. A form with unsent text
     * turns this off: a stray tap above a bottom sheet is easy, and it would
     * throw the text away. Escape and Close always close.
     */
    closeOnBackdrop?: boolean;
    // `RefObject<T | null>` is what React 19's `useRef<T>(null)` returns.
    initialFocusRef?: React.RefObject<HTMLElement | null>;
    children: React.ReactNode;
};

export function Sheet({
    open,
    onClose,
    title,
    closeLabel,
    closeOnBackdrop = true,
    initialFocusRef,
    children,
}: SheetProps) {
    const titleId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    // A press that STARTED on the scrim. Selecting text inside the panel and
    // releasing outside it must not close the sheet.
    const backdropPressRef = useRef(false);

    // Portals need a DOM; render nothing on the server pass.
    const mounted = useInBrowser();

    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [open]);

    // Focus in on open; back to the opener on close. `mounted` is a dependency
    // because a sheet hydrated already open has no panel on its first commit:
    // the portal only appears once the client snapshot takes over.
    useEffect(() => {
        if (!open || !mounted) return;

        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const panel = panelRef.current;
        const target = initialFocusRef?.current ?? (panel ? focusableWithin(panel)[0] : null) ?? panel;
        target?.focus();

        return () => {
            openerRef.current?.focus();
            openerRef.current = null;
        };
    }, [open, mounted, initialFocusRef]);

    // Escape and Tab containment, in the capture phase so the sheet wins over
    // handlers inside it.
    useEffect(() => {
        if (!open) return;

        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
            }

            if (event.key !== 'Tab') return;

            const panel = panelRef.current;
            if (!panel) return;

            const items = focusableWithin(panel);
            const active = document.activeElement;

            if (items.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }

            const first = items[0];
            const last = items[items.length - 1];
            const inside = panel.contains(active);

            if (event.shiftKey) {
                if (!inside || active === first) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (!inside || active === last) {
                event.preventDefault();
                first.focus();
            }
        }

        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [open, onClose]);

    const handleBackdropMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        backdropPressRef.current = event.target === event.currentTarget;
    }, []);

    const handleBackdropClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            const startedOnBackdrop = backdropPressRef.current;
            backdropPressRef.current = false;
            if (!closeOnBackdrop || !startedOnBackdrop) return;
            onClose();
        },
        [closeOnBackdrop, onClose],
    );

    if (!mounted || !open) return null;

    return createPortal(
        <div
            data-capture-exclude=""
            className="fixed inset-0 z-50 flex items-end justify-center sm:items-stretch sm:justify-end"
            // The scrim token, as Modal uses it: dark swaps in a deeper black.
            style={{ backgroundColor: 'var(--jale-backdrop)' }}
            onMouseDown={handleBackdropMouseDown}
            onClick={handleBackdropClick}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={[
                    'anim-fade-in flex w-full flex-col overflow-hidden outline-none',
                    'bg-[var(--jale-card)] text-[var(--jale-ink)] shadow-[var(--shadow-modal)]',
                    // Phone: anchored to the bottom edge, rounded on top, never
                    // taller than the visible viewport (dvh tracks the browser
                    // chrome that vh ignores).
                    'max-h-[92dvh] rounded-t-[var(--radius-card)]',
                    // 640px up: a full-height panel on the right.
                    'sm:h-full sm:max-h-none sm:w-[28rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-none sm:rounded-l-[var(--radius-card)]',
                ].join(' ')}
            >
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--jale-divider)] py-2 pl-5 pr-3">
                    <h2 id={titleId} className="min-w-0 text-base font-bold text-[var(--jale-ink)]">
                        {title}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={closeLabel}
                        title={closeLabel}
                        className={[
                            // ThemeToggle's recipe: a 40px box with a 44px
                            // pointer target from the ::after overlay.
                            'relative inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full',
                            'text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                        ].join(' ')}
                    >
                        <Icon name="x" />
                    </button>
                </div>
                {children}
            </div>
        </div>,
        document.body,
    );
}

/** The scrolling region of a sheet. */
export function SheetBody({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return (
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 ${className}`}>
            {children}
        </div>
    );
}

/**
 * Actions pinned under the body. The bottom padding clears the home indicator
 * on notched phones, where a bottom sheet sits flush with the screen edge.
 */
export function SheetFooter({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return (
        <div
            className={`flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--jale-divider)] bg-[var(--jale-card)] px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${className}`}
        >
            {children}
        </div>
    );
}
