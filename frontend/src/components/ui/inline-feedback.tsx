'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from './icon';

/**
 * Inline feedback banner — result of an action, shown in place (next to the
 * form or panel it belongs to) rather than floating over the page like a toast.
 *
 * Use this when the message must stay on screen and stay attached to its
 * context ("Saved", "3 fields need attention"). Use `useToast` when the message
 * is ambient and can disappear on its own.
 */

export type FeedbackTone = 'success' | 'warning' | 'danger' | 'info';

/**
 * Each tone pairs a tinted background with its dedicated *-text token. The base
 * `--jale-success/-warning/-danger` colours are tuned for white; the -text
 * variants are the ones that stay AA-legible on these tints.
 */
export const feedbackToneClasses: Record<FeedbackTone, string> = {
    success: 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]',
    warning: 'bg-[var(--jale-warning-bg)] text-[var(--jale-warning-text)]',
    danger: 'bg-[var(--jale-danger-bg)] text-[var(--jale-danger-text)]',
    info: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
};

/**
 * Problems interrupt (`alert`); confirmations wait their turn (`status`).
 * Announcing a "Saved" banner assertively would talk over whatever the user is
 * doing next.
 */
export function feedbackRole(tone: FeedbackTone): 'alert' | 'status' {
    return tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
}

export function InlineFeedback({
    tone,
    onDismiss,
    className = '',
    children,
}: {
    tone: FeedbackTone;
    onDismiss?: () => void;
    className?: string;
    children: React.ReactNode;
}) {
    const t = useTranslations('common');

    return (
        <div
            role={feedbackRole(tone)}
            className={[
                'flex items-start gap-2 rounded-[var(--radius-input)] px-3.5 py-2.5 text-sm font-medium',
                feedbackToneClasses[tone],
                className,
            ].join(' ')}
        >
            <span className="min-w-0 flex-1">{children}</span>

            {onDismiss ? (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={t('feedback.dismiss')}
                    className="-mr-1 -mt-0.5 shrink-0 cursor-pointer rounded p-1 leading-none opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                    <Icon name="x" />
                </button>
            ) : null}
        </div>
    );
}
