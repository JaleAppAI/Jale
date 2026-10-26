import { guideTarget } from '../spotlight/steps';

/**
 * Small readers for a guide's conditions (`when`, `ready`, `advanceWhen`).
 * They read the page as it is now, never React state, so a guide stays plain
 * data about controls marked `data-guide`.
 */

/** The text field, select or textarea at or inside `control`. */
export function fieldIn(control: Element): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
    if (
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement ||
        control instanceof HTMLTextAreaElement
    ) {
        return control;
    }
    return control.querySelector('input, select, textarea');
}

/** True when the field at or inside `control` holds something other than spaces. */
export function hasText(control: Element): boolean {
    return (fieldIn(control)?.value.trim() ?? '') !== '';
}

/** The value of the field marked `data-guide="<name>"`, or null when it is not on screen. */
export function valueOf(name: string): string | null {
    const control = guideTarget(name);
    const field = control ? fieldIn(control) : null;
    return field ? field.value : null;
}

/** True when the control at or inside `control` carries `data-picked` (see `LocationPicker`). */
export function isPicked(control: Element): boolean {
    return control.matches('[data-picked]') || control.querySelector('[data-picked]') !== null;
}
