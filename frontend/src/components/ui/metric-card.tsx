import { Icon } from './icon';
import type { IconName } from './icon';

/**
 * Unified metric card. Its API is a superset of the two divergent inline
 * `MetricCard`s that previously lived in the employer pages:
 *
 *  - variant='filled' (default) reproduces the DASHBOARD card
 *    (src/app/[locale]/employer/dashboard/page.tsx): tone-tinted icon chip on
 *    a white panel. Tones used there: blue, teal, ink, amber.
 *  - variant='accent' reproduces the MESSAGES card
 *    (src/app/[locale]/employer/conversations/page.tsx): a top-border accent
 *    stripe with tone-colored value text. Tones used there: blue, green, amber,
 *    navy.
 *
 * `hint` maps to the dashboard's `hint` prop and the messages page's `detail`
 * prop (same slot). This one component can replace both existing definitions.
 */

export type MetricTone = 'blue' | 'teal' | 'amber' | 'ink' | 'green' | 'navy';
export type MetricVariant = 'filled' | 'accent';

// tone -> icon chip background/text, mapped onto existing --jale-* tokens.
// blue -> blue-50/blue-700, teal -> teal-50/teal ink, amber -> warning,
// ink/navy -> paper-2/ink (the neutral chip), green -> success.
//
// Every pair is token-on-token so the chips invert with the theme. `ink` and
// `navy` previously hardcoded #eef0f7 with blue-900 text; blue-900 stays dark
// in BOTH themes, so it cannot sit on a surface that darkens. The paper-2/ink
// pair is the same neutral read in light and stays legible in dark.
const filledTones: Record<MetricTone, string> = {
    blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
    teal: 'bg-[var(--jale-teal-50)] text-[#137965]',
    amber: 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)]',
    ink: 'bg-[var(--jale-paper-2)] text-[var(--jale-ink)]',
    green: 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]',
    navy: 'bg-[var(--jale-paper-2)] text-[var(--jale-ink)]',
};

// tone -> accent stripe color + value text color (messages page palette).
const accentTones: Record<MetricTone, string> = {
    blue: 'before:bg-[var(--jale-blue-500)] text-[var(--jale-blue-500)]',
    teal: 'before:bg-[var(--jale-teal-500)] text-[var(--jale-teal-500)]',
    amber: 'before:bg-[var(--jale-warning)] text-[var(--jale-warning)]',
    ink: 'before:bg-[var(--jale-blue-900)] text-[var(--jale-blue-900)]',
    green: 'before:bg-[var(--jale-success)] text-[var(--jale-success)]',
    navy: 'before:bg-[var(--jale-blue-900)] text-[var(--jale-blue-900)]',
};

// Icon selection mirrors the dashboard's inline mapping for the filled variant.
const filledIcons: Record<MetricTone, IconName> = {
    blue: 'briefcase',
    teal: 'user',
    amber: 'clock',
    ink: 'chart',
    green: 'user',
    navy: 'chart',
};

export function MetricCard({
    label,
    value,
    hint,
    tone = 'blue',
    variant = 'filled',
}: {
    label: string;
    value: string | number;
    hint?: string;
    tone?: MetricTone;
    variant?: MetricVariant;
}) {
    if (variant === 'accent') {
        return (
            <div
                className={`relative overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-[var(--jale-card)] p-4 before:absolute before:left-0 before:right-0 before:top-0 before:h-1 ${accentTones[tone]}`}
            >
                <p className="text-2xl font-extrabold leading-none">{value}</p>
                <p className="mt-2 text-sm font-bold text-[var(--jale-ink)]">{label}</p>
                {hint ? <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p> : null}
            </div>
        );
    }

    return (
        <div className="min-h-[128px] rounded-2xl border border-[var(--jale-divider)] bg-[var(--jale-card)] p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
            <div className={`mb-4 inline-flex h-9 w-9 items-center justify-center rounded-xl ${filledTones[tone]}`}>
                <Icon name={filledIcons[tone]} />
            </div>
            <p className="text-3xl font-extrabold leading-none text-[var(--jale-ink)]">{value}</p>
            <p className="mt-2 text-xs font-bold uppercase text-[var(--jale-ink-2)]">{label}</p>
            {hint ? <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{hint}</p> : null}
        </div>
    );
}
