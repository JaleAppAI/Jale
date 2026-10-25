/**
 * The walkthrough's own hold on the page's scroll.
 *
 * `Modal` and `Sheet` lock the page by saving the body's inline `overflow`,
 * setting `hidden`, and putting the saved value back when they close. That is
 * right only while locks are let go in the reverse order they were taken. A
 * walkthrough that moves between the page and a dialog takes and lets go of
 * its hold in between a dialog's own: on the body it would either undo the
 * dialog's lock while the dialog is open, or be handed its own `hidden` back
 * when the dialog closes and leave the page locked after it ends.
 *
 * So it holds a property no dialog touches: the root element's inline
 * `overflow` (the page scrolls with the viewport, which takes the root's
 * value). Holds are counted, the value found before the first one is put back
 * after the last, and only while the walkthrough's own `hidden` is still
 * there: it never writes over a value it did not set.
 */

let holds = 0;
let before = '';

/** Stops the page scrolling until the returned release is called (once; later calls do nothing). */
export function holdPageScroll(): () => void {
    const style = document.documentElement.style;
    if (holds === 0) {
        before = style.overflow;
        style.overflow = 'hidden';
    }
    holds += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds > 0) return;
        if (style.overflow === 'hidden') style.overflow = before;
        before = '';
    };
}
