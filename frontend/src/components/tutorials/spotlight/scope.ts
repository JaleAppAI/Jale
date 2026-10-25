import {
    CALLOUT_GAP,
    VIEWPORT_GUTTER,
    cutoutFor,
    outOfBandWith,
    scrollToFit,
    scrollToShow,
    unionBox,
    type Band,
    type Box,
} from './geometry';
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

/** An element's box, in viewport px. */
function boxOf(element: Element): Box {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/** The box a control takes together with its open popups (a combobox's list). */
function extentOf(control: Element, popups: readonly Element[]): Box {
    return unionBox(boxOf(control), ...popups.map(boxOf));
}

/** Room kept between a scrolled-to control and the edge of its scrolling box, in px. */
const SCROLL_MARGIN = 12;

/**
 * Scrolls `container` the least it takes to show `element` (with a margin),
 * the way `scrollIntoView({ block: 'nearest' })` would, but without touching
 * any other scroller: the page behind a dialog stays where it is.
 */
export function scrollIntoContainer(element: Element, container: HTMLElement, popups: readonly Element[] = []): void {
    const box = container.getBoundingClientRect();
    if (popups.length > 0) {
        // With its open list: the two together, the list as far as it fits.
        const band = { top: box.top, bottom: box.bottom };
        container.scrollTop += scrollToShow(extentOf(element, popups), boxOf(element), band, SCROLL_MARGIN);
        return;
    }
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

/** A modal dialog, of any kind. */
const MODAL_DIALOG = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * Whether a modal dialog other than the walkthrough's own is open: one that
 * is not a walkthrough's callout, and does not hold `scope` (the dialog the
 * walkthrough runs in, if any). A confirm or a form opened over the step.
 */
export function modalOver(scope: HTMLElement | null): boolean {
    const own = scope !== null && scope !== document.body ? scope : null;
    for (const dialog of Array.from(document.querySelectorAll(MODAL_DIALOG))) {
        if (dialog.closest('[data-spotlight]') !== null) continue;
        if (own !== null && dialog.contains(own)) continue;
        return true;
    }
    return false;
}

/** Room kept between a revealed control and the page's fixed chrome, in px. */
const CHROME_MARGIN = 12;

/** The fixed or sticky element `element` is, or sits in; null for plain page content. */
function fixedOrSticky(element: Element): HTMLElement | null {
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
        const { position } = window.getComputedStyle(node);
        if (position === 'fixed' || position === 'sticky') return node as HTMLElement;
    }
    return null;
}

/**
 * The phone tab bar's height, as the bar writes it on `<html>` while it shows
 * (`BottomTabBar`); 0 where it is hidden.
 */
function tabBarOffset(): number {
    const value = parseFloat(document.documentElement.style.getPropertyValue('--jale-tab-bar-offset'));
    return Number.isFinite(value) ? value : 0;
}

/**
 * The part of the viewport the page's content shows in: below a fixed or
 * sticky header, above the phone tab bar or other fixed chrome at the bottom.
 */
export function visiblePageBand(): Band {
    let top = 0;
    let bottom = window.innerHeight - tabBarOffset();
    const x = window.innerWidth / 2;
    const header = pageElementAt(x, 1);
    const above = header ? fixedOrSticky(header) : null;
    if (above) top = Math.max(top, above.getBoundingClientRect().bottom);
    const footer = pageElementAt(x, window.innerHeight - 1);
    const below = footer ? fixedOrSticky(footer) : null;
    if (below) bottom = Math.min(bottom, below.getBoundingClientRect().top);
    return bottom > top ? { top, bottom } : { top: 0, bottom: window.innerHeight };
}

/** Whether a control on the page is taller than what the page shows of itself at once (a long row on a phone). */
export function tallerThanPage(control: HTMLElement): boolean {
    if (fixedOrSticky(control) !== null) return false;
    const band = visiblePageBand();
    return control.getBoundingClientRect().height > band.bottom - band.top;
}

/** The page's own element on top at (x, y): the walkthrough's layer is left out. */
function pageElementAt(x: number, y: number): Element | null {
    if (typeof document.elementsFromPoint !== 'function') return null;
    return document.elementsFromPoint(x, y).find((element) => element.closest('[data-spotlight]') === null) ?? null;
}

/**
 * Scrolls a control on the page into view clear of the page's fixed chrome.
 * `scrollIntoView({ block: 'nearest' })` alone can leave it at the very
 * bottom of the viewport, under the phone tab bar, where its cutout would
 * show the bar and a tap on it would follow a tab. So the bottom keeps room
 * for the bar, and then whatever fixed or sticky element is still on top of
 * the control (a sticky header above, a bar below) is scrolled clear of it.
 * A control that is itself in the chrome (the app tour's tab-bar stops) is
 * left where it is. A control taller than what the page shows (a long row
 * on a phone) is scrolled to show its top, under room for the callout of
 * `calloutHeight`, and the person scrolls the rest.
 */
export function revealOnPage(control: HTMLElement, calloutHeight = 0, popups: readonly Element[] = []): void {
    if (fixedOrSticky(control) !== null) return;
    const scroller = scrollParentWithin(control, document.body);
    const scrollBy = (dy: number) => {
        if (dy === 0) return;
        if (scroller !== null) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
    };
    if (tallerThanPage(control)) {
        const page = scroller ?? document.scrollingElement;
        const at = scroller !== null ? scroller.scrollTop : window.scrollY;
        const end = page ? page.scrollHeight - page.clientHeight : 0;
        const rect = control.getBoundingClientRect();
        const hole = cutoutFor({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        scrollBy(scrollToFit(hole, calloutHeight, visiblePageBand(), { min: -at, max: Math.max(0, end - at) }));
        return;
    }
    if (popups.length > 0) {
        // With its open list (a combobox's suggestions): the two together
        // above the tab bar and below a header, the list as far as it fits,
        // so its options can be tapped.
        scrollBy(scrollToShow(extentOf(control, popups), boxOf(control), visiblePageBand(), CHROME_MARGIN));
    } else {
        // Optional call: jsdom has no scrollIntoView.
        control.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const bar = tabBarOffset();
        if (bar > 0) {
            const rect = control.getBoundingClientRect();
            const limit = window.innerHeight - bar - CHROME_MARGIN;
            if (rect.bottom > limit) scrollBy(Math.min(rect.bottom - limit, Math.max(0, rect.top - CHROME_MARGIN)));
        }
    }
    const parts = [control, ...popups];
    const rect = extentOf(control, popups);
    const rectBottom = rect.top + rect.height;
    const middle = rect.top + rect.height / 2;
    const x = rect.left + rect.width / 2;
    for (const y of [middle, rectBottom - 2, rect.top + 2]) {
        const top = pageElementAt(x, y);
        if (top === null || parts.some((part) => part.contains(top))) continue;
        const cover = fixedOrSticky(top);
        if (cover === null) continue;
        const box = cover.getBoundingClientRect();
        // In the lower half of the viewport: a bar from below; else a header from above.
        if (box.top + box.height / 2 > window.innerHeight / 2) scrollBy(rectBottom - box.top + CHROME_MARGIN);
        else scrollBy(-(box.bottom - rect.top + CHROME_MARGIN));
        return;
    }
}

/**
 * Whether a change of layout has carried a control on the page out of the
 * part of the viewport it can be seen in: above it, below it or the phone tab
 * bar, or under fixed chrome. A control taller than that part never counts.
 */
export function outOfPageBand(control: HTMLElement, popups: readonly Element[] = []): boolean {
    if (fixedOrSticky(control) !== null) return false;
    if (popups.length > 0 && !tallerThanPage(control)) {
        return outOfBandWith(extentOf(control, popups), boxOf(control), visiblePageBand());
    }
    const rect = control.getBoundingClientRect();
    const bottom = window.innerHeight - tabBarOffset();
    if (rect.height > bottom) return false;
    if (rect.top < 0 || rect.bottom > bottom) return true;
    const top = pageElementAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return top !== null && !control.contains(top) && fixedOrSticky(top) !== null;
}

/** The same for a control in a dialog's scrolling body. */
export function outOfContainer(element: Element, container: HTMLElement, popups: readonly Element[] = []): boolean {
    const box = container.getBoundingClientRect();
    if (popups.length > 0) {
        return outOfBandWith(extentOf(element, popups), boxOf(element), { top: box.top, bottom: box.bottom });
    }
    const rect = element.getBoundingClientRect();
    if (rect.height > box.height) return false;
    return rect.top < box.top || rect.bottom > box.bottom;
}

/**
 * After the control is in view in a dialog's scrolling body: scrolls the body
 * on (as little as it takes, and as far as it can) so the callout, of
 * `calloutHeight`, fits above or below the control inside the body too,
 * rather than being drawn over it (`scrollToFit`).
 */
export function scrollToFitCallout(
    control: HTMLElement,
    container: HTMLElement,
    calloutHeight: number,
    popups: readonly Element[] = [],
): void {
    const rect = extentOf(control, popups);
    const box = container.getBoundingClientRect();
    const range = {
        min: -container.scrollTop,
        max: Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop),
    };
    const hole = cutoutFor({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    // A control with an open list that leaves no room for the callout keeps
    // the list in view: the callout goes past the body instead.
    if (popups.length > 0 && hole.height + calloutHeight + CALLOUT_GAP + VIEWPORT_GUTTER > box.height) return;
    const scroll = scrollToFit(hole, calloutHeight, { top: box.top, bottom: box.bottom }, range);
    if (scroll !== 0) container.scrollTop += scroll;
}
