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
    // `flex-wrap` + `min-w-0` because this was a non-wrapping flex: a long title
    // beside a wide action slot could not shrink, so the header set a floor on
    // the page width and pushed the whole layout into horizontal scroll at
    // 390px — reproducibly, in Spanish, where the labels are longer.
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <h2 className="min-w-0 text-base font-bold text-current">{title}</h2>
            {action}
        </div>
    );
}
