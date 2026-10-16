'use client';

import { Button } from './button';
import { Icon, type IconName } from './icon';
import { StateAction } from './empty-state';

/**
 * Error state: the counterpart to `EmptyState` for "this did not work"
 * (copied from the Jale app). The caller passes a kind, never a message, so
 * every failure in the console reads the same way. `title` and `body` exist
 * for the rare surface that needs its own words.
 */

/** The app's error kinds (frontend `lib/api/errors.ts`), redefined here. */
export type ErrorKind =
    | 'offline'
    | 'timeout'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'gone'
    | 'conflict'
    | 'validation'
    | 'rate_limited'
    | 'server'
    | 'legal_wall'
    | 'unknown';

const MESSAGES: Record<ErrorKind, string> = {
    offline: 'You appear to be offline. Check your connection and try again.',
    timeout: 'This is taking longer than expected. Please try again.',
    unauthorized: 'Your session expired. Please sign in again.',
    forbidden: "You don't have access to this.",
    not_found: "We couldn't find what you're looking for.",
    gone: 'This is no longer available.',
    conflict: "That didn't go through because something changed. Refresh and try again.",
    validation: 'Some information is missing or invalid. Please review and try again.',
    rate_limited: 'Too many attempts. Please wait a moment and try again.',
    server: 'Something went wrong on our side. Please try again in a few minutes.',
    legal_wall: 'Something went wrong. Please try again.',
    unknown: 'Something went wrong. Please try again.',
};

/** Kinds where trying the same thing again can plausibly work. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['offline', 'timeout', 'rate_limited', 'server']);

/** Transient problems read as a caution, not a failure. */
const WARNING_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['offline', 'timeout']);

function iconFor(kind: ErrorKind): IconName {
    if (kind === 'offline' || kind === 'timeout') return 'wifi-off';
    if (kind === 'not_found' || kind === 'gone') return 'search';
    if (kind === 'rate_limited') return 'clock';
    return 'alert';
}

export function ErrorState({
    kind,
    onRetry,
    backHref,
    title,
    body,
    compact = false,
}: {
    kind: ErrorKind;
    onRetry?: () => void;
    backHref?: string;
    title?: string;
    body?: string;
    compact?: boolean;
}) {
    const resolvedTitle =
        title ?? (kind === 'not_found' ? 'Not found' : kind === 'offline' ? 'No connection' : 'Something went wrong');
    const resolvedBody = body ?? MESSAGES[kind];
    const showRetry = Boolean(onRetry) && (RETRYABLE.has(kind) || kind === 'unknown');
    const showBack = Boolean(backHref);

    const tileClasses = WARNING_KINDS.has(kind)
        ? 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)]'
        : 'bg-[var(--jale-danger-bg)] text-[var(--jale-danger-text)]';

    return (
        <div
            role="alert"
            className={[
                'flex flex-col items-center justify-center text-center',
                compact ? 'px-4 py-6' : 'min-h-[280px] px-6 py-12',
            ].join(' ')}
        >
            <span className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg ${tileClasses}`}>
                <Icon name={iconFor(kind)} />
            </span>

            <p className="text-sm font-semibold text-[var(--jale-ink)]">{resolvedTitle}</p>
            <p className="mt-1 max-w-sm text-sm text-[var(--jale-ink-2)]">{resolvedBody}</p>

            {showRetry || showBack ? (
                <div className={`${compact ? 'mt-4' : 'mt-5'} flex flex-wrap items-center justify-center gap-2`}>
                    {showRetry ? (
                        <Button variant="primary" onClick={onRetry}>
                            Try again
                        </Button>
                    ) : null}
                    {showBack && backHref ? <StateAction action={{ label: 'Go back', href: backHref }} tone="ghost" /> : null}
                </div>
            ) : null}
        </div>
    );
}
