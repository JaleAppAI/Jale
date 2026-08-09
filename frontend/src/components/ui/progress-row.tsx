/**
 * Labelled progress bar row.
 *
 * Label left, figure right, hairline bar underneath. Two things beyond the
 * original extraction:
 *
 *  - The figure is `tabular-nums`, so a stack of these keeps its digits on a
 *    shared vertical rhythm instead of jittering as counts change.
 *  - The bar carries real `progressbar` semantics. It used to be two nested
 *    divs — visually a progress bar, and nothing at all to a screen reader.
 *    `aria-valuetext` announces the figure the sighted reader sees ("3/5")
 *    rather than the raw percentage, which is the number that actually means
 *    something on these rows.
 *
 * `percent` is clamped here (and guarded against NaN from a 0/0 ratio) so no
 * call site can paint a bar past its track.
 */
export function ProgressRow({
    label,
    value,
    percent,
}: {
    label: string;
    value: string;
    percent: number;
}) {
    const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

    return (
        <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold">
                <span className="min-w-0 text-current">{label}</span>
                <span className="shrink-0 tabular-nums text-current opacity-70">{value}</span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clamped)}
                aria-valuetext={value}
                className="h-2 overflow-hidden rounded-full bg-[var(--jale-paper-2)]"
            >
                <div
                    className="h-full rounded-full bg-[var(--jale-blue-500)]"
                    style={{ width: `${clamped}%` }}
                />
            </div>
        </div>
    );
}
