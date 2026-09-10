import * as React from 'react';

/**
 * Title + optional action row for a `DashboardPanel`.
 * Extracted verbatim from the employer dashboard's inline `PanelHeader`.
 *
 * `leading` and `subtitle` are ReactNode slots rather than flags: the profile
 * pages needed an avatar beside the title and hand-rolled the whole row to get
 * one, which is how two copies of this geometry came to exist. A slot the
 * caller fills keeps the divider row, the padding and the wrap behaviour here,
 * where every panel in the app already shares them.
 */
export function PanelHeader({
    title,
    subtitle,
    leading,
    action,
}: {
    title: string;
    subtitle?: React.ReactNode;
    leading?: React.ReactNode;
    action?: React.ReactNode;
}) {
    // `flex-wrap` + `min-w-0` because this was a non-wrapping flex: a long title
    // beside a wide action slot could not shrink, so the header set a floor on
    // the page width and pushed the whole layout into horizontal scroll at
    // 390px — reproducibly, in Spanish, where the labels are longer.
    //
    // `[overflow-wrap:anywhere]` on the title because `title` is user-supplied
    // on the profile pages (`company_name`, `full_name`): an unbroken 60-char
    // name offers no break opportunity, and `min-w-0` alone cannot wrap what has
    // nowhere to wrap, so it would overflow the row at 375px. Wrapping onto a
    // second line is the deliberate trade-off over `truncate` — clipping
    // somebody's name is worse than spending a line on it.
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
                {leading}
                <div className="min-w-0">
                    <h2 className="min-w-0 text-base font-bold text-current [overflow-wrap:anywhere]">{title}</h2>
                    {subtitle ? (
                        <p className="text-sm text-[var(--jale-ink-2)]">{subtitle}</p>
                    ) : null}
                </div>
            </div>
            {action}
        </div>
    );
}
