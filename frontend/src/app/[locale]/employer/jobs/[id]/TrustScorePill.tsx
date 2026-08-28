'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

/**
 * The worker's trust score, beside the match badge on an applicant row.
 *
 * Deliberately `neutral` and deliberately unbanded: the match badge next to it
 * is already colour-coded, and a second coloured verdict on the same row turns
 * a skim into an argument between two scores that measure different things.
 * This one is a number the employer can open the profile to understand.
 *
 * Renders NOTHING for a null score. "Trust 0" beside a strong match would
 * libel every worker who simply never took the assessment.
 */
export function TrustScorePill({ score }: { score: number | null }) {
    const t = useTranslations('employer_job_listing');
    if (score === null) return null;
    return (
        <Badge tone="neutral">
            <span className="tabular-nums">{t('applicants.trust_pill', { score })}</span>
        </Badge>
    );
}
