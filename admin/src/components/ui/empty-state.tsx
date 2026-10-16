'use client';

import Link from 'next/link';
import { Button } from './button';
import { Icon, type IconName } from './icon';

/**
 * Empty state: "there is nothing here, and that is fine" (copied from the
 * Jale app). `default` is a genuinely empty collection; `filtered` means the
 * current filters hide the results, so it is tighter.
 *
 * Admin links never prefetch: a page may record a read when it renders, and a
 * prefetch must never record a read the admin did not make.
 */

export type EmptyStateAction = {
    label: string;
    /** In-app destination, rendered as a real link. */
    href?: string;
    /** Non-navigating action (clear filters, retry). */
    onClick?: () => void;
};

export type EmptyStateVariant = 'default' | 'filtered';

/** Anchor styled as a button: an <a> may not contain a <button>. Mirrors button.tsx. */
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

export function StateAction({ action, tone }: { action: EmptyStateAction; tone: 'primary' | 'ghost' }) {
    if (action.href) {
        return (
            <Link href={action.href} prefetch={false} className={`${actionLinkBase} ${actionLinkTones[tone]}`}>
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
    const resolvedIcon: IconName = icon ?? (variant === 'filtered' ? 'search' : 'briefcase');

    return (
        <div
            className={[
                'flex flex-col items-center justify-center text-center',
                variant === 'filtered' ? 'px-4 py-8' : 'px-6 py-12',
                className,
            ].join(' ')}
        >
            {/* blue-700 on the blue-50 tint: both flip in dark. */}
            <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]">
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
