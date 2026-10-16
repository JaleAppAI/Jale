import type { ReactNode } from 'react';

/**
 * The ONE label/value layout.
 *
 * Single column of stacked rows: label on the left in small uppercase ink-2,
 * value right-aligned in ink. Rows are separated by a dashed hairline (the last
 * row has none), which is what keeps a long field list readable without giving
 * every pair its own box.
 *
 * Sizing is deliberately flexible rather than a fixed two-column grid: at 390px
 * a long value would otherwise squeeze the label into one character per line.
 * The label is capped at 45% and the value takes the rest, breaking mid-word
 * only when it truly cannot fit (emails, URLs, long addresses).
 */

export type KVItem = {
    label: ReactNode;
    value: ReactNode;
};

export function KVList({ items, className = '' }: { items: KVItem[]; className?: string }) {
    if (items.length === 0) return null;

    return (
        <dl className={['w-full', className].filter(Boolean).join(' ')}>
            {items.map((item, index) => (
                <div
                    // Items are a positional list with no stable identity of their
                    // own; they are never reordered in place.
                    key={index}
                    className={[
                        'flex items-baseline justify-between gap-4 py-2.5',
                        index < items.length - 1
                            ? 'border-b border-dashed border-[var(--jale-divider)]'
                            : '',
                    ]
                        .filter(Boolean)
                        .join(' ')}
                >
                    <dt className="min-w-0 max-w-[45%] text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
                        {item.label}
                    </dt>
                    <dd className="min-w-0 flex-1 text-right text-sm font-medium text-[var(--jale-ink)] [overflow-wrap:anywhere]">
                        {item.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
