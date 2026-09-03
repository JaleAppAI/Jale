'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ApplicationStatusBadge, Badge } from '@/components/ui/badge';
import { MatchScoreBadge } from '@/components/ui/match-signals';
import { initialsFor } from '@/components/employer/ConversationThread';
import type { ApplicantOverviewItem } from '@/lib/api/employer';

const MAX_SKILL_BADGES = 4;

/**
 * One row of the cross-job applicants dashboard: identity, which job (title ·
 * city — the disambiguator when the same title is posted in several cities),
 * status, the cached match score, and a capped skill strip. Everything deeper
 * lives on the worker profile page this row links to.
 */
export function ApplicantOverviewRow({ item }: { item: ApplicantOverviewItem }) {
  const t = useTranslations('employer_applicants');
  const tShared = useTranslations('employer_dashboard');
  const tMatch = useTranslations('match');
  const format = useFormatter();

  const name = item.worker_name ?? t('unknown_worker');
  const jobLine = item.job_city ? `${item.job_title} · ${item.job_city}` : item.job_title;
  const appliedDate = new Date(item.applied_at);
  const applied = Number.isFinite(appliedDate.getTime())
    ? t('applied_on', { date: format.dateTime(appliedDate, { month: 'short', day: 'numeric' }) })
    : null;
  const shownSkills = item.skills.slice(0, MAX_SKILL_BADGES);
  const hiddenSkills = item.skills.length - shownSkills.length;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="avatar-initials h-9 w-9 shrink-0 text-[11px]">{initialsFor(name)}</span>

      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-bold text-[var(--jale-ink)]">{name}</p>
        <p className="truncate text-xs text-[var(--jale-ink-2)]">{jobLine}</p>
        {applied ? (
          <p className="mt-0.5 text-[11px] tabular-nums text-[var(--jale-ink-2)]">{applied}</p>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ApplicationStatusBadge status={item.application_status}>
          {tShared(`applicants.status.${item.application_status}`)}
        </ApplicationStatusBadge>
        {item.match_score !== null && item.score_band !== null ? (
          <MatchScoreBadge
            score={item.match_score}
            band={item.score_band}
            label={tMatch(`score_bands.${item.score_band}`)}
          />
        ) : (
          <span className="text-[11px] font-medium text-[var(--jale-ink-2)]">{t('not_scored')}</span>
        )}
        {shownSkills.map((skill) => (
          <Badge key={skill} tone="info">{skill}</Badge>
        ))}
        {hiddenSkills > 0 ? <Badge tone="neutral">{`+${hiddenSkills}`}</Badge> : null}
      </div>

      <Link
        href={`/employer/workers/${item.worker_id}?job_id=${item.job_id}`}
        className="shrink-0 text-xs font-bold text-[var(--primary)] underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {tShared('applicants.view_profile')}
      </Link>
    </div>
  );
}
