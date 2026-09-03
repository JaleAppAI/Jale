'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { RequirementsRemaining } from '@/lib/api/employer';
import type { ApplicationDetailsStatus } from '@/lib/status';

/**
 * How much of stage 2 an applicant still owes, as one badge beside their
 * status chip.
 *
 * `details_status` and `status` answer DIFFERENT questions and legitimately
 * disagree: the status is where the employer put the applicant, the details
 * status is derived from `details_requested_at`/`details_completed_at`. Moving
 * a `details_requested` applicant on to "In conversation" does not un-request
 * their details, so both have to be visible at once.
 *
 * Fail-open: `status` is optional because the frontend may ship ahead of the
 * backend. Absent means the API doesn't publish stage-2 vocabulary yet, and
 * this renders NOTHING -- an applicant list that silently claims "not
 * requested" for everyone would be worse than one that says nothing at all.
 */
export function ApplicantDetailsIndicator({
    status,
    remaining,
}: {
    status?: ApplicationDetailsStatus;
    remaining?: RequirementsRemaining;
}) {
    const t = useTranslations('employer_job_listing');

    if (!status) return null;

    if (status === 'complete') {
        return <Badge tone="success">{t('applicants.details.complete')}</Badge>;
    }

    if (status === 'not_requested') {
        return <Badge tone="neutral">{t('applicants.details.not_requested')}</Badge>;
    }

    const count = remainingCount(remaining);
    return (
        <Badge tone="warning">
            {count === null
                // A count-less variant rather than an interpolated `undefined`:
                // an older API can publish `details_status` without `remaining`,
                // and "requested · left" reads as a bug.
                ? t('applicants.details.requested_no_count')
                : t('applicants.details.requested', { count })}
        </Badge>
    );
}

/**
 * How many things still block a hire. All four buckets are already
 * blocking-only by construction (`remainingView` drops optional fields/docs
 * and the uncollectable legacy `ssn`), so this is a plain sum -- the same
 * arithmetic the worker's own progress bar shows.
 */
export function remainingCount(remaining?: RequirementsRemaining): number | null {
    if (!remaining?.counts) return null;
    const { prompts, fields, certifications, docs } = remaining.counts;
    return prompts + fields + certifications + docs;
}
