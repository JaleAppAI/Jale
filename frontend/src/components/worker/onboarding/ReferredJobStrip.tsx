'use client';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { ReferredJobSummary } from '@/lib/api/worker';

/**
 * "Applying to: **<job title>** · <company>" — one slim line under
 * the progress rail, on every onboarding screen (decided 2026-10-01).
 *
 * A worker who came in on a job link used to fill in eight screens without the
 * job being named once, and lost it entirely the moment they changed tab or
 * device. This line keeps it in view, and it reads the SERVER's answer rather
 * than anything in this tab, so it is there wherever they pick up.
 *
 * Non-interactive by design: it states context, the summary screen is where
 * the job is acted on. Long titles wrap rather than overflow (`overflow-wrap:
 * anywhere` for an unbroken word) and the line is capped at two rows, so the
 * strip stays slim and the screen under it starts in the same place on every
 * step.
 *
 * Tokens only: this is a themed surface, not the brand band above it.
 */
export function ReferredJobStrip({ job }: { job: ReferredJobSummary }) {
    const t = useTranslations('worker_onboarding.referred_job');

    return (
        <p className="line-clamp-2 px-[22px] pt-2.5 text-[13px] leading-snug text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">
            {t.rich(job.open ? 'strip' : 'strip_closed', {
                title: job.title,
                company: job.company,
                b: (chunks: ReactNode) => <strong className="font-semibold text-[var(--jale-ink)]">{chunks}</strong>,
                // The base line is already the muted ink; the suffix just has
                // to read as quieter than the title it follows.
                muted: (chunks: ReactNode) => <span className="font-normal">{chunks}</span>,
            })}
        </p>
    );
}
