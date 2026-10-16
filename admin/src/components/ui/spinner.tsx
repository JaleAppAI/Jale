/**
 * The one spinner. Previously this markup was copy-pasted inline in
 * `button.tsx` (md) and the upload page (sm); both now render this.
 *
 * It draws with `border-current`, so it inherits the surrounding text colour
 * and needs no tone prop.
 *
 * Without `label` the spinner is decorative (`aria-hidden`) — correct when it
 * sits next to visible loading text, which is the common case. Pass `label`
 * only when the spinner is the *sole* indication that something is happening;
 * it then announces itself via a `role="status"` wrapper.
 */

import * as React from 'react';

export type SpinnerSize = 'sm' | 'md';

const sizeClasses: Record<SpinnerSize, string> = {
    sm: 'h-3.5 w-3.5',
    md: 'h-4 w-4',
};

export function Spinner({
    size = 'md',
    label,
    className = '',
}: {
    size?: SpinnerSize;
    label?: string;
    className?: string;
}) {
    const circle = (
        <span
            aria-hidden="true"
            className={`${sizeClasses[size]} shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
        />
    );

    if (!label) return circle;

    return (
        <span role="status" className="inline-flex items-center">
            {circle}
            <span className="sr-only">{label}</span>
        </span>
    );
}
