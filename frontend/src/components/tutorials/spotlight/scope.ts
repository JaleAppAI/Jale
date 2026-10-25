import { isRendered } from './steps';

/**
 * Where a spotlight lives: on the page, or inside the dialog its control sits
 * in (the post-job wizard is a `Modal`).
 *
 * WHY INSIDE THE DIALOG. A `Modal` panel is `aria-modal`, traps Tab and owns
 * Escape and the page's scroll lock. A callout outside it could not be
 * reached by Tab or by a screen reader, and the dialog's scrim (z-50) would
 * cover it. So when a step's control is inside a `[role="dialog"]`, the
 * engine portals its scrim, blockers and callout into that dialog, leaves the
 * scroll lock to it, scrolls the control into view inside the dialog's own
 * scrolling body, and keeps the callout within that body (clear of the pinned
 * header and footer).
 */

/** The dialog panel a control sits in, or null for a control on the page itself. */
export function dialogOf(element: Element): HTMLElement | null {
    const dialog = element.closest<HTMLElement>('[role="dialog"]');
    // A callout is a dialog too; a control is never inside one.
    if (dialog === null || dialog.closest('[data-spotlight]') !== null) return null;
    return dialog;
}

/** The nearest ancestor of `element`, up to and including `scope`, that scrolls vertically. */
export function scrollParentWithin(element: Element, scope: Element): HTMLElement | null {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
        const { overflowY } = window.getComputedStyle(node);
        if (overflowY === 'auto' || overflowY === 'scroll') return node;
        if (node === scope) break;
    }
    return null;
}

/** Room kept between a scrolled-to control and the edge of its scrolling box, in px. */
const SCROLL_MARGIN = 12;

/**
 * Scrolls `container` the least it takes to show `element` (with a margin),
 * the way `scrollIntoView({ block: 'nearest' })` would, but without touching
 * any other scroller: the page behind a dialog stays where it is.
 */
export function scrollIntoContainer(element: Element, container: HTMLElement): void {
    const box = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const above = box.top + SCROLL_MARGIN - rect.top;
    const below = rect.bottom - (box.bottom - SCROLL_MARGIN);
    if (above > 0) container.scrollTop -= above;
    else if (below > 0) container.scrollTop += Math.min(below, -above);
}

/**
 * The popups an expanded control inside `target` owns, by `aria-controls`: a
 * combobox's open list sits outside the field's own box, and is part of the
 * control while it is open (the cutout takes it in, so it can be clicked).
 */
export function openPopupsOf(target: Element): HTMLElement[] {
    const owners = [target, ...Array.from(target.querySelectorAll('[aria-expanded="true"]'))].filter(
        (owner) => owner.getAttribute('aria-expanded') === 'true',
    );
    const popups: HTMLElement[] = [];
    for (const owner of owners) {
        for (const id of (owner.getAttribute('aria-controls') ?? '').split(/\s+/)) {
            const popup = id ? document.getElementById(id) : null;
            if (popup && isRendered(popup) && !popups.includes(popup)) popups.push(popup);
        }
    }
    return popups;
}

/** True when focus is in a control whose popup is open: Escape closes that first. */
export function ownsOpenPopup(element: Element | null): boolean {
    return element instanceof HTMLElement && element.getAttribute('aria-expanded') === 'true';
}
