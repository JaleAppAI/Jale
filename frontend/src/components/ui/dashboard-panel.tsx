import * as React from 'react';

/**
 * Rounded white panel used across dashboard-style surfaces.
 * Extracted verbatim from the employer dashboard's inline `DashboardPanel`.
 */
export function DashboardPanel({
    children,
    className = '',
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <section className={`rounded-2xl border border-[var(--jale-divider)] bg-white shadow-[var(--shadow-card)] ${className}`}>
            {children}
        </section>
    );
}
