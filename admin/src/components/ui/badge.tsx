import type { ReactNode } from 'react';

/**
 * The ONE status chip (copied from the Jale app, core only).
 *
 * A badge is a small coloured dot followed by muted text: colour carries the
 * state, the text carries the meaning, and nothing paints a background.
 * Every dot colour is a `--jale-*` token, so `.dark` re-tints it.
 */

export type BadgeTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

/** Tone -> dot colour. Literal classes so Tailwind sees them; tokens behind them. */
const toneDotClasses: Record<BadgeTone, string> = {
    info: 'bg-[var(--jale-blue-500)]',
    success: 'bg-[var(--jale-success)]',
    warning: 'bg-[var(--jale-warning)]',
    danger: 'bg-[var(--jale-danger)]',
    neutral: 'bg-[var(--jale-ink-2)]',
};

export function Badge({
    tone = 'neutral',
    dotClassName,
    labelClassName,
    className = '',
    children,
}: {
    tone?: BadgeTone;
    /** Override the dot colour when a caller needs a tone the palette lacks. */
    dotClassName?: string;
    /** Override the label colour; applied to the label itself so it wins. */
    labelClassName?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            className={[
                'inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-tight',
                className,
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <span
                aria-hidden
                className={['size-[7px] shrink-0 rounded-full', dotClassName ?? toneDotClasses[tone]]
                    .filter(Boolean)
                    .join(' ')}
            />
            <span className={['min-w-0', labelClassName ?? 'text-[var(--jale-ink-2)]'].join(' ')}>
                {children}
            </span>
        </span>
    );
}
