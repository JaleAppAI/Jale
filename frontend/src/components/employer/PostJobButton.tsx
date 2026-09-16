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
    const { openPostJob, opening } = usePostJob();

    return (
        <Button
            size={size}
            className={className}
            onClick={() => openPostJob()}
            loading={opening}
            loadingLabel={tCommon('loading')}
        >
            <Icon name="plus" />
            {children ?? t('jobs.post_job')}
        </Button>
    );
}
