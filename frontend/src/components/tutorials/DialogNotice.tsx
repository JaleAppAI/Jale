'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon } from '@/components/ui/icon';
import { feedbackToneClasses } from '@/components/ui/inline-feedback';

/**
 * A toast's message, shown inside a dialog.
 *
 * The app's toasts sit under the dialog layer (z-40, under a `Modal`'s z-50)
 * and outside the dialog, which is `aria-modal`: a confirmation for something
 * done inside a dialog would be dimmed by its backdrop and passed over by a
 * screen reader. This draws the same card in the dialog panel, just above the
 * dialog's pinned footer, as a `status` line, and takes it away after the
 * toast's own time (or on its dismiss button).
 *
 * It outlives whatever showed it (a guide ends as it mutes itself), so it has
 * its own React root, one per dialog, mounted at the end of the panel and
 * removed with its last message. A second message in the same dialog takes
 * the first one's place and starts the time again.
 *
 * Only `GuideHost` uses it, so it stays in the guides' lazy chunk.
 */

export type DialogNoticeTone = 'success' | 'danger';

export type DialogNotice = {
    tone: DialogNoticeTone;
    message: string;
    /** The dismiss button's accessible name. */
    dismissLabel: string;
};

/** The toast's own time on screen (`components/ui/toast`). */
export const DIALOG_NOTICE_TTL_MS = 5000;

/**
 * The live region is drawn empty first and the message put in it a moment
 * later: a region that arrives with its text already in it is not reliably
 * read out.
 */
const ANNOUNCE_DELAY_MS = 50;

/** Room between the card and the dialog's footer (or its bottom edge), in px. */
const GAP = 12;

type Shown = { node: HTMLElement; root: Root; timer: ReturnType<typeof setTimeout> | null };

const shown = new WeakMap<HTMLElement, Shown>();

/** Shows `notice` in `dialog` (a `[role="dialog"]` panel), in place of any notice already there. */
export function showDialogNotice(dialog: HTMLElement, notice: DialogNotice): void {
    let entry = shown.get(dialog);
    if (entry === undefined || !entry.node.isConnected) {
        const node = document.createElement('div');
        node.setAttribute('data-dialog-notice', '');
        // A zero-height strip at the end of the panel: the card hangs above
        // it, so it covers the bottom of the dialog's body, not its footer.
        node.className = 'relative h-0 shrink-0';
        dialog.appendChild(node);
        entry = { node, root: createRoot(node), timer: null };
        shown.set(dialog, entry);
    }
    const current = entry;
    const close = () => {
        if (current.timer !== null) clearTimeout(current.timer);
        current.timer = null;
        if (shown.get(dialog) === current) shown.delete(dialog);
        current.root.unmount();
        current.node.remove();
    };
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = setTimeout(close, DIALOG_NOTICE_TTL_MS);
    current.root.render(
        <NoticeCard
            dialog={dialog}
            anchor={current.node}
            notice={notice}
            // Not from inside the root's own event: unmounted once it is done.
            onDismiss={() => queueMicrotask(close)}
        />,
    );
}

/** The dialog's scrolling body: the panel child that scrolls. */
function scrollBodyOf(dialog: HTMLElement): HTMLElement | null {
    for (const child of Array.from(dialog.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const { overflowY } = window.getComputedStyle(child);
        if (overflowY === 'auto' || overflowY === 'scroll') return child;
    }
    return null;
}

function NoticeCard({
    dialog,
    anchor,
    notice,
    onDismiss,
}: {
    dialog: HTMLElement;
    anchor: HTMLElement;
    notice: DialogNotice;
    onDismiss: () => void;
}) {
    const [text, setText] = useState<DialogNotice | null>(null);
    const [bottom, setBottom] = useState(GAP);

    useEffect(() => {
        const timer = setTimeout(() => setText(notice), ANNOUNCE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [notice]);

    // Hangs from the strip at the end of the panel up to the body's bottom
    // edge, measured, so a footer of any height stays clear.
    useLayoutEffect(() => {
        const measure = () => {
            const body = scrollBodyOf(dialog);
            const offset = body ? anchor.getBoundingClientRect().top - body.getBoundingClientRect().bottom : 0;
            setBottom(Math.max(0, offset) + GAP);
        };
        measure();
        window.addEventListener('resize', measure);
        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(dialog);
        }
        return () => {
            window.removeEventListener('resize', measure);
            observer?.disconnect();
        };
    }, [dialog, anchor]);

    return (
        <div
            role="status"
            className="pointer-events-none absolute inset-x-4 z-10 flex flex-col sm:left-auto sm:w-80"
            style={{ bottom }}
        >
            {text !== null ? (
                <div
                    role={text.tone === 'danger' ? 'alert' : undefined}
                    className="anim-fade-in pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3.5 py-3 text-sm shadow-[var(--shadow-card)]"
                >
                    <span
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${feedbackToneClasses[text.tone]}`}
                    >
                        <Icon name={text.tone === 'danger' ? 'alert' : 'check'} />
                    </span>
                    <span className="min-w-0 flex-1 pt-1 font-medium text-[var(--jale-ink)]">{text.message}</span>
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label={text.dismissLabel}
                        className="-mr-1 shrink-0 cursor-pointer rounded p-1 leading-none text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                        <Icon name="x" />
                    </button>
                </div>
            ) : null}
        </div>
    );
}
