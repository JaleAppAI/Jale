/**
 * Labelled progress bar row.
 * Extracted verbatim from the employer dashboard's inline `ProgressRow`.
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
    return (
        <div>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold">
                <span className="text-current">{label}</span>
                <span className="text-current opacity-70">{value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--jale-paper-2)]">
                <div
                    className="h-full rounded-full bg-[var(--jale-blue-500)]"
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                />
            </div>
        </div>
    );
}
