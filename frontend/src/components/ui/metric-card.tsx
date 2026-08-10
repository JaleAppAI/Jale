import type { IconName } from './icon';

/**
 * KPI metric — a bare number.
 *
 * The locked style strips this back to the data: an extrabold tabular figure
 * over a small uppercase label, with no card box, no border and no icon chip.
 * A dashboard row of these reads as one comparable set of numbers instead of
 * four competing tiles, and it collapses cleanly to a single column on mobile
 * because there is no box geometry to hold.
 *
 * PROPS ARE INTENTIONALLY BACKWARD-COMPATIBLE. `icon` and `variant` are
 * accepted and IGNORED — they described chrome (icon chip, accent stripe) that
 * the minimal presentation no longer has. Keeping them in the signature is what
 * lets all four consumer pages compile with zero diffs; drop them only in a
 * pass that also updates every call site. `tone` survives with reduced scope:
 * it tints the value where the tint carries meaning, and is otherwise ink.
 */

export type MetricTone = 'blue' | 'teal' | 'amber' | 'ink' | 'green' | 'navy';
export type MetricVariant = 'filled' | 'accent';

/**
 * Only the two tones that mean something at a glance get colour: green for a
 * good outcome, amber for something needing attention. `blue`/`teal`/`ink`/
 * `navy` were decorative variety, not signal, so they render as plain ink —
 * which is the point of a minimal metric.
 *
 * Both tinted tokens carry separate light and dark values tuned for contrast on
 * their own background, so neither needs a per-theme override here.
 */
const valueToneClasses: Record<MetricTone, string> = {
    blue: 'text-[var(--jale-ink)]',
    teal: 'text-[var(--jale-ink)]',
    ink: 'text-[var(--jale-ink)]',
    navy: 'text-[var(--jale-ink)]',
    green: 'text-[var(--jale-success)]',
    amber: 'text-[var(--jale-warning)]',
};

// `variant` and `icon` are deliberately NOT destructured below: they stay in the
// props type so call sites keep compiling, but nothing reads them.
export function MetricCard({
    label,
    value,
    hint,
    tone = 'blue',
    className = '',
}: {
    label: string;
    value: string | number;
    hint?: string;
    tone?: MetricTone;
    /** Accepted for source compatibility; the minimal metric has one presentation. */
    variant?: MetricVariant;
    /** Accepted for source compatibility; the minimal metric renders no icon. */
    icon?: IconName;
    className?: string;
}) {
    return (
        <div className={['min-w-0 py-1', className].filter(Boolean).join(' ')}>
            <p className={`text-3xl font-extrabold leading-none tabular-nums ${valueToneClasses[tone]}`}>
                {value}
            </p>
            <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                {label}
            </p>
            {hint ? (
                <p className="mt-1 text-xs font-medium text-[var(--jale-ink-2)]">{hint}</p>
            ) : null}
        </div>
    );
}
