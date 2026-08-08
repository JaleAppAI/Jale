'use client';

import { useTranslations } from 'next-intl';
import type { ErrorKind } from '@/lib/api/errors';
import { Button } from './button';
import { Icon, type IconName } from './icon';
import { StateAction } from './empty-state';

/**
 * Error state — the counterpart to `EmptyState` for "this did not work".
 *
 * The caller passes an `ErrorKind`, never a message. Copy is assembled here so
 * every failure in the app says the same thing in the same register in both
 * locales, and so a new call site cannot invent its own wording. `title` and
 * `body` overrides exist for the rare surface that needs domain-specific
 * phrasing.
 */

/**
 * `ErrorKind` is single-sourced in `@/lib/api/errors` (where `classifyError`
 * produces it). Re-exported here so existing `import type { ErrorKind } from
 * '.../error-state'` call sites keep resolving to the same canonical union.
 */
export type { ErrorKind };

/**
 * Kinds where trying the exact same thing again can plausibly succeed. Offering
 * "Try again" on, say, `forbidden` would just teach users the button is a lie.
 */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
    'offline',
    'timeout',
    'rate_limited',
    'server',
]);

/** Kinds where the resource is gone/blocked, so the only move is to go back. */
const GO_BACK_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
    'not_found',
    'gone',
    'forbidden',
]);

/** Transient/connectivity problems read as a caution, not a failure. */
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
    const t = useTranslations('common');

    const resolvedTitle =
        title ??
        (kind === 'not_found'
            ? t('error_state.not_found_title')
            : kind === 'offline'
              ? t('error_state.offline_title')
              : t('error_state.title'));

    // `legal_wall` has no user-facing sentence of its own — the legal wall UI
    // owns that conversation; here it degrades to the generic message.
    const resolvedBody = body ?? t(`errors.${kind === 'legal_wall' ? 'unknown' : kind}`);

    const showRetry = Boolean(onRetry) && (RETRYABLE.has(kind) || kind === 'unknown');
    const showBack = Boolean(backHref) && GO_BACK_KINDS.has(kind);

    const warning = WARNING_KINDS.has(kind);
    const tileClasses = warning
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
            <span
                className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg ${tileClasses}`}
            >
                <Icon name={iconFor(kind)} />
            </span>

            <p className="text-sm font-semibold text-[var(--jale-ink)]">{resolvedTitle}</p>
            <p className="mt-1 max-w-sm text-sm text-[var(--jale-ink-2)]">{resolvedBody}</p>

            {showRetry || showBack ? (
                <div className={`${compact ? 'mt-4' : 'mt-5'} flex flex-wrap items-center justify-center gap-2`}>
                    {showRetry ? (
                        <Button variant="primary" onClick={onRetry}>
                            {t('retry')}
                        </Button>
                    ) : null}
                    {showBack && backHref ? (
                        <StateAction
                            action={{ label: t('error_state.go_back'), href: backHref }}
                            tone="ghost"
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
