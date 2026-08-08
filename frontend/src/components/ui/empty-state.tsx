'use client';

import { Link } from '@/i18n/navigation';
import { Button } from './button';
import { Icon, type IconName } from './icon';

/**
 * Empty state — the "there is nothing here, and that is fine" surface.
 *
 * Two variants, because the two cases mean different things to the user:
 *  - `default`  : the collection is genuinely empty (first-run). Roomy, since
 *                 it is usually the only thing on screen.
 *  - `filtered` : results exist but the current filters hide them. Tighter,
 *                 because it sits directly under a filter bar the user is
 *                 actively working, and it must not push that bar off-screen.
 */

export type EmptyStateAction = {
    label: string;
    /** In-app destination. Rendered as a link (real anchor, middle-clickable). */
    href?: string;
    /** Non-navigating action (clear filters, open a modal, retry a fetch). */
    onClick?: () => void;
};

export type EmptyStateVariant = 'default' | 'filtered';

/**
 * Anchor styled as a button.
 *
 * `Button` renders a `<button>`, and an `<a>` may not contain interactive
 * content (nor vice versa), so a link-shaped action cannot reuse the component
 * directly. The recipe below mirrors `button.tsx`'s primary/ghost + default
 * size output.
 *
 * TODO: delete this once `Button` grows an `asChild`/`render` escape hatch —
 * changing Button's API is out of scope for this package.
 */
const actionLinkBase = [
    'inline-flex items-center justify-center gap-2 rounded-full font-semibold',
    'cursor-pointer select-none whitespace-nowrap leading-none',
    'transition-all duration-150',
    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
    'active:scale-[0.98]',
    'h-11 px-5 text-sm',
].join(' ');

const actionLinkTones = {
    primary: 'bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]',
    ghost: 'bg-transparent text-[var(--jale-ink)] border border-[var(--jale-divider)] hover:bg-[var(--jale-paper-2)]',
} as const;

export function StateAction({
    action,
    tone,
}: {
    action: EmptyStateAction;
    tone: 'primary' | 'ghost';
}) {
    if (action.href) {
        return (
            <Link href={action.href} className={`${actionLinkBase} ${actionLinkTones[tone]}`}>
                {action.label}
            </Link>
        );
    }

    return (
        <Button variant={tone} onClick={action.onClick}>
            {action.label}
        </Button>
    );
}

export function EmptyState({
    icon,
    title,
    body,
    action,
    secondaryAction,
    variant = 'default',
    className = '',
}: {
    icon?: IconName;
    title: string;
    body?: string;
    action?: EmptyStateAction;
    secondaryAction?: EmptyStateAction;
    variant?: EmptyStateVariant;
    className?: string;
}) {
    // A magnifying glass reads as "your search came up short"; a briefcase reads
    // as "this part of the product has nothing in it yet".
    const resolvedIcon: IconName = icon ?? (variant === 'filtered' ? 'search' : 'briefcase');

    return (
        <div
            className={[
                'flex flex-col items-center justify-center text-center',
                variant === 'filtered' ? 'px-4 py-8' : 'px-6 py-12',
                className,
            ].join(' ')}
        >
            {/* 40px tile — the `.stat-icon` recipe one step up in size. */}
            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--jale-blue-50)] text-[var(--jale-blue-600)]">
                <Icon name={resolvedIcon} />
            </span>

            <p className="text-sm font-semibold text-[var(--jale-ink)]">{title}</p>
            {body ? <p className="mt-1 max-w-sm text-sm text-[var(--jale-ink-2)]">{body}</p> : null}

            {action || secondaryAction ? (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    {action ? <StateAction action={action} tone="primary" /> : null}
                    {secondaryAction ? <StateAction action={secondaryAction} tone="ghost" /> : null}
                </div>
            ) : null}
        </div>
    );
}
