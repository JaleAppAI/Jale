import * as React from 'react';

/**
 * Title + optional action row for a `DashboardPanel`.
 * Extracted verbatim from the employer dashboard's inline `PanelHeader`.
 */
export function PanelHeader({
    title,
    action,
}: {
    title: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <h2 className="text-base font-bold text-current">{title}</h2>
            {action}
        </div>
    );
}
