import type { ReactNode } from 'react';
import { DashboardPanel } from '@/components/ui/dashboard-panel';

/**
 * The static pieces of a tutorial scene: the mock cards, rows, chips, chat
 * bubbles, avatars, labels and fields the prototype's slides are drawn from.
 *
 * Every colour is a `--jale-*` token, so the scenes re-tint in dark mode with
 * the rest of the app, and the one card is `DashboardPanel` (the app's only
 * card recipe). Nothing here is interactive: a mock button is a `span`, never
 * a `button`, and every piece is `aria-hidden` because the slide's text, not
 * the picture, carries the meaning.
 *
 * `className` is for LAYOUT only (a width, `self-end`, `flex-1`). The look is
 * the piece's own, so every scene in every tutorial stays one family.
 */

function cx(...parts: Array<string | false | undefined>): string {
    return parts.filter(Boolean).join(' ');
}

/** A mock screen card: the app's card on the stage, 11 px type, a column of rows. */
export function SceneFrame({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <div aria-hidden="true" className={className}>
            <DashboardPanel as="div" className="flex flex-col gap-2 p-2.5 text-[11px] text-[var(--jale-ink)]">
                {children}
            </DashboardPanel>
        </div>
    );
}

/** A label and an optional trailing value, as in a details list. `divider` draws the rule above it. */
export function SceneRow({
    trailing,
    divider = false,
    className,
    children,
}: {
    trailing?: ReactNode;
    divider?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            aria-hidden="true"
            className={cx(
                'flex items-center justify-between gap-2 py-1.5',
                divider && 'border-t border-[var(--jale-divider)]',
                className,
            )}
        >
            <span className="min-w-0">{children}</span>
            {trailing !== undefined ? <span className="shrink-0">{trailing}</span> : null}
        </div>
    );
}

export type SceneChipTone = 'blue' | 'success' | 'warning' | 'neutral' | 'plain' | 'outline' | 'current' | 'primary' | 'ink';
export type SceneChipSize = 'xs' | 'sm' | 'md' | 'lg';

const CHIP_TONES: Record<SceneChipTone, string> = {
    blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)] font-semibold',
    success: 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)] font-bold',
    warning: 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)] font-bold',
    neutral: 'bg-[var(--jale-input)] text-[var(--jale-ink-2)] font-semibold',
    plain: 'bg-[var(--jale-card)] text-[var(--jale-ink)] font-semibold',
    outline: 'border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] font-semibold',
    // The step the person is on (onboarding's third question): a teal ring.
    current: 'border-2 border-[var(--jale-teal-500)] bg-[var(--jale-card)] text-[var(--jale-ink)] font-bold',
    // A mock primary button. White on the one CTA blue, as `Button` paints it.
    primary: 'bg-[var(--jale-blue-500)] text-white font-semibold',
    // A dark toast ("Link copied"). Inverts with the theme: ink on card.
    ink: 'bg-[var(--jale-ink)] text-[var(--jale-card)] font-semibold',
};

const CHIP_SIZES: Record<SceneChipSize, string> = {
    xs: 'px-2 py-[3px]',
    sm: 'px-2.5 py-1',
    md: 'px-3.5 py-1.5 text-xs',
    // A mock button: a fixed 32 px pill.
    lg: 'h-8 px-3.5',
};

/** A pill: a tag, a status, or a mock button (`tone="primary"`, `size="lg"`). */
export function SceneChip({
    tone = 'blue',
    size = 'xs',
    className,
    children,
}: {
    tone?: SceneChipTone;
    size?: SceneChipSize;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full',
                CHIP_TONES[tone],
                CHIP_SIZES[size],
                className,
            )}
        >
            {children}
        </span>
    );
}

const BUBBLE_TONES = {
    // An outgoing message from the app (the employer's own, in blue).
    brand: 'bg-[var(--jale-blue-500)] text-white',
    // The same message as it lands on WhatsApp: the success tint stands in
    // for WhatsApp's green so it re-tints in dark mode.
    whatsapp: 'bg-[var(--jale-success-bg)] text-[var(--jale-ink)]',
    muted: 'bg-[var(--jale-input)] text-[var(--jale-ink)]',
    plain: 'bg-[var(--jale-card)] text-[var(--jale-ink)]',
} as const;

/** A chat bubble. `side` sets which edge it hugs and which corner carries the tail. */
export function SceneBubble({
    side,
    tone = 'plain',
    className,
    children,
}: {
    side: 'start' | 'end';
    tone?: keyof typeof BUBBLE_TONES;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'block max-w-full rounded-[10px] px-2 py-1.5 leading-snug',
                side === 'start' ? 'self-start rounded-bl-[2px]' : 'self-end rounded-br-[2px]',
                BUBBLE_TONES[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}

const AVATAR_TONES = {
    teal: 'bg-[var(--jale-teal-50)] text-[var(--jale-success-text)]',
    blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
    warning: 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)]',
} as const;

/** Initials in a tinted circle, for a sample person. Use made-up initials only. */
export function SceneAvatar({
    initials,
    tone = 'teal',
    size = 'md',
}: {
    initials: string;
    tone?: keyof typeof AVATAR_TONES;
    size?: 'sm' | 'md';
}) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'inline-flex shrink-0 items-center justify-center rounded-full font-bold',
                size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-8 w-8 text-[11px]',
                AVATAR_TONES[tone],
            )}
        >
            {initials}
        </span>
    );
}

/** A small uppercase eyebrow over a field or a panel ("JOB TITLE", "WHATSAPP"). */
export function SceneLabel({
    tone = 'muted',
    className,
    children,
}: {
    tone?: 'muted' | 'success';
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'text-[9px] font-bold uppercase tracking-[0.06em]',
                tone === 'success' ? 'text-[var(--jale-success-text)]' : 'text-[var(--jale-ink-2)]',
                className,
            )}
        >
            {children}
        </span>
    );
}

/**
 * A mock input. `focused` draws the blue focus border on the card fill;
 * `caret` adds a typing caret after the value (pair it with `TypeOn`).
 */
export function SceneField({
    focused = false,
    caret = false,
    size = 'sm',
    className,
    children,
}: {
    focused?: boolean;
    caret?: boolean;
    size?: 'sm' | 'md';
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            aria-hidden="true"
            className={cx(
                'flex items-center gap-1 overflow-hidden rounded-lg px-2 font-semibold',
                size === 'sm' ? 'h-[26px]' : 'h-[34px] text-xs',
                focused
                    ? 'border-2 border-[var(--jale-blue-500)] bg-[var(--jale-card)]'
                    : 'bg-[var(--jale-input)]',
                className,
            )}
        >
            {children}
            {caret ? <span data-scene-caret="" className="h-3.5 w-px shrink-0 bg-[var(--jale-ink)]" /> : null}
        </div>
    );
}

const NOTE_TONES = {
    neutral: 'bg-[var(--jale-input)] text-[var(--jale-ink)]',
    warning: 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)] font-semibold',
    success: 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)] font-semibold',
    blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)] font-semibold',
    plain: 'bg-[var(--jale-card)] text-[var(--jale-ink)]',
    // An empty slot waiting to be filled, such as a document not uploaded yet.
    empty: 'border border-dashed border-[var(--jale-blue-200)] text-[var(--jale-ink)]',
} as const;

/**
 * A tinted block whose text wraps: a quote in the worker's own words, a "this
 * locks" warning, a saved-document row, or an empty upload slot.
 */
export function SceneNote({
    tone = 'neutral',
    className,
    children,
}: {
    tone?: keyof typeof NOTE_TONES;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div aria-hidden="true" className={cx('rounded-lg px-2 py-1.5 leading-snug', NOTE_TONES[tone], className)}>
            {children}
        </div>
    );
}
