'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { usePostJob } from '@/contexts/PostJobContext';

type PostJobButtonProps = {
    /** Matches `Button`'s own sizes; the shell action and panels differ. */
    size?: 'default' | 'sm' | 'lg';
    className?: string;
    /** Overrides the label — the dashboard hero says "Post a job". */
    children?: ReactNode;
};

/**
 * The one control that opens the post-a-job wizard, wherever an employer is.
 *
 * It carries no state and no gate of its own: `PostJobContext` owns the modal,
 * the plan-limit preflight and the dialog that replaces the wizard when the
 * plan has no slot left. That is what lets this sit in `AppShell`'s `actions`
 * slot on every employer page instead of only on the dashboard.
 */
export function PostJobButton({ size, className = '', children }: PostJobButtonProps) {
    const t = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const { openPostJob, canOpen, opening } = usePostJob();

    /*
     * Disabled while there is no session to post with -- the restore window on
     * a reload, or a session `AuthContext` is masking because it belongs to the
     * other role. The alternative is a control that looks live and does
     * nothing, which reads as a broken button rather than as "not yet".
     *
     * `Button` renders its label and its loading state in one grid cell, so
     * neither this nor `opening` moves anything on the page. `aria-disabled`
     * is set alongside the real `disabled` so assistive tech is told the same
     * thing in both states, including the busy one, where `disabled` is set by
     * `loading` rather than by us.
     */
    const inert = !canOpen || opening;

    return (
        <Button
            size={size}
            className={className}
            onClick={() => openPostJob()}
            disabled={!canOpen}
            aria-disabled={inert || undefined}
            loading={opening}
            loadingLabel={tCommon('loading')}
        >
            <Icon name="plus" />
            {children ?? t('jobs.post_job')}
        </Button>
    );
}
