import type { ReactNode } from 'react';

/**
 * A named, focusable scroll region for a wide table: the table scrolls inside
 * it, never the page, and a keyboard user can scroll it once focused. The
 * parent needs `min-w-0` (grid/flex children default to their content width).
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div
            role="region"
            aria-label={label}
            tabIndex={0}
            className="max-w-full overflow-x-auto rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
            {children}
        </div>
    );
}
