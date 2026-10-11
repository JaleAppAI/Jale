'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Whether the docked stub should be up: true while the ticket is out of sight
 * behind or below it, false once the ticket's top edge rises above it.
 *
 * Attach `ticketRef` to the ticket and `dockRef` to the stub. The observer's
 * viewport is the real one with the stub's own height taken off the bottom, so
 * "intersecting" means some of the ticket -- its top edge first -- has cleared
 * the stub line. That is exactly when the stub steps aside, and while it is up
 * the whole ticket is under that line, so Apply is never on screen twice.
 *
 * The stub is HELD IN STATE (`dockRef` is a callback ref), not a ref object,
 * because it is portalled into `document.body` and can arrive a commit after
 * the ticket. The observer starts when it does, so the line is always drawn
 * from a stub that exists rather than from a height of 0.
 *
 * It is measured once, when the observer starts. Its height is pinned by an
 * h-11 button and two one-line rows, so the only thing that moves it on a live
 * screen is the safe-area inset changing with a rotation: a few pixels on the
 * line, against an Apply that sits a whole ticket body below the top edge.
 *
 * `false` until the observer first reports, so a screen tall enough to show
 * the ticket outright never flashes the stub on the way in. And `false` for
 * good where there is no IntersectionObserver (an old browser, jsdom): the
 * ticket alone is the whole experience, and only the shortcut is lost.
 */
export function useTicketDock() {
    const ticketRef = useRef<HTMLElement>(null);
    const [dock, setDock] = useState<HTMLElement | null>(null);
    const [dockShown, setDockShown] = useState(false);

    useEffect(() => {
        const ticket = ticketRef.current;
        // Checked here, never during render: the server has no observer
        // either, and both renders must agree on a stowed stub.
        if (!ticket || !dock || typeof IntersectionObserver === 'undefined') return;

        // `offsetHeight`, not a bounding rect: the stub is translated out of
        // view while it is stowed, and only its layout height is the line.
        const observer = new IntersectionObserver(
            (entries) => {
                // One callback can carry several crossings after a fast
                // scroll; the last one is where the ticket is now.
                const latest = entries[entries.length - 1];
                if (latest) setDockShown(!latest.isIntersecting);
            },
            { rootMargin: `0px 0px -${dock.offsetHeight}px 0px` },
        );
        observer.observe(ticket);
        return () => observer.disconnect();
    }, [dock]);

    return { ticketRef, dockRef: setDock, dockShown };
}
