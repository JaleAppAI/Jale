import * as React from 'react';

/**
 * Rounded card-surface panel used across dashboard-style surfaces.
 * Extracted verbatim from the employer dashboard's inline `DashboardPanel`;
 * the fill is `--jale-card` rather than a literal white so it re-tints in dark.
 */
export function DashboardPanel({
    children,
    className = '',
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={`rounded-2xl border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)] ${className}`}>
            {children}
        </section>
    );
}
