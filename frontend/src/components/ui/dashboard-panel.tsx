import * as React from 'react';

/**
 * Rounded card-surface panel used across dashboard-style surfaces.
 * Extracted verbatim from the employer dashboard's inline `DashboardPanel`;
 * the fill is `--jale-card` rather than a literal white so it re-tints in dark.
 *
 * This is the app's ONE card recipe. `as` exists because a few surfaces owe the
 * document a different element -- the public job page's card IS an `<article>`
 * -- and before this the only way to get one was to hand-copy the class list,
 * which is exactly how the two recipes drifted apart in the first place.
 */
export function DashboardPanel({
    children,
    className = '',
    as: Tag = 'section',
}: {
    children: React.ReactNode;
    className?: string;
    as?: 'section' | 'article' | 'div';
}) {
    return (
        <Tag className={`rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)] ${className}`}>
            {children}
        </Tag>
    );
}
