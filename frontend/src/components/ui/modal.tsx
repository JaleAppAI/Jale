'use client';

import * as React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Icon } from './icon';

/**
 * Accessible modal dialog.
 *
 * Everything a dialog owes the user is handled here so no call site has to
 * re-derive it: focus moves in on open and returns to whatever opened it on
 * close, Tab cannot escape the panel, Escape and backdrop clicks close it, and
 * the page behind stops scrolling while it is up.
 *
 * Rendered through a portal on `document.body` so the panel is never clipped by
 * an ancestor's `overflow` and never inherits a stacking context that would put
 * it behind the page.
 */

export type ModalSize = 'sm' | 'md' | 'lg';

const sizeClasses: Record<ModalSize, string> = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
};

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
 * (`display:none`, a collapsed section) — those would otherwise become dead
 * stops in the tab cycle.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true',
    );
}

export function Modal({
    open,
    onClose,
    labelledById,
    title,
    size = 'md',
    closeOnOverlay = true,
    closeOnEscape = true,
    initialFocusRef,
    footer,
    children,
}: {
    open: boolean;
    onClose: () => void;
    /** Point at your own heading element instead of passing `title`. */
    labelledById?: string;
    title?: React.ReactNode;
    size?: ModalSize;
    closeOnOverlay?: boolean;
    closeOnEscape?: boolean;
    initialFocusRef?: React.RefObject<HTMLElement>;
    footer?: React.ReactNode;
    children: React.ReactNode;
}) {
    const t = useTranslations('common');
    const generatedTitleId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    // Backdrop presses that *started* on the backdrop. Without this, selecting
    // text inside the panel and releasing outside it would close the dialog.
    const backdropPressRef = useRef(false);

    // Portals need a DOM; render nothing on the server pass.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const titleId = labelledById ?? (title ? generatedTitleId : undefined);

    // Scroll-lock the page behind the dialog, restoring whatever was there
    // before (some pages set their own overflow).
    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [open]);

    // Move focus in on open; hand it back to the opener on close.
    useEffect(() => {
        if (!open) return;

        openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const panel = panelRef.current;
        const target = initialFocusRef?.current ?? (panel ? focusableWithin(panel)[0] : null) ?? panel;
        target?.focus();

        return () => {
            openerRef.current?.focus();
            openerRef.current = null;
        };
    }, [open, initialFocusRef]);

    // Escape to close + Tab containment. Capture phase so the dialog wins over
    // handlers on the content inside it.
    useEffect(() => {
        if (!open) return;

        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') {
                if (!closeOnEscape) return;
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

            // Nothing focusable inside: keep focus parked on the panel itself
            // rather than letting Tab walk out into the page behind.
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
    }, [open, closeOnEscape, onClose]);

    const handleBackdropMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        backdropPressRef.current = event.target === event.currentTarget;
    }, []);

    const handleBackdropClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (!closeOnOverlay) return;
            if (event.target !== event.currentTarget) return;
            if (!backdropPressRef.current) return;
            backdropPressRef.current = false;
            onClose();
        },
        [closeOnOverlay, onClose],
    );

    if (!mounted || !open) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            // The scrim is a token (`--jale-backdrop`) rather than a literal:
            // the light theme's 45% ink tint all but disappears over a dark
            // page, so dark swaps in a deeper black. Still inline because it is
            // an alpha composite, not a Tailwind colour utility.
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
                    'max-h-[92vh] rounded-[var(--radius-card)] bg-[var(--jale-card)] shadow-[var(--shadow-modal)]',
                    sizeClasses[size],
                ].join(' ')}
            >
                {title ? (
                    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                        <h2 id={titleId} className="text-base font-bold text-[var(--jale-ink)]">
                            {title}
                        </h2>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label={t('feedback.dismiss')}
                            className="-mr-1.5 -mt-1 shrink-0 cursor-pointer rounded p-1.5 leading-none text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                            <Icon name="x" />
                        </button>
                    </div>
                ) : null}

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

                {footer ? (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--jale-divider)] bg-[var(--jale-card)] px-5 py-3">
                        {footer}
                    </div>
                ) : null}
            </div>
        </div>,
        document.body,
    );
}
