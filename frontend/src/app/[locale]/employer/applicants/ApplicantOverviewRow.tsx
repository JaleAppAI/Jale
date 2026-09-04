'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ApplicationStatusBadge, Badge } from '@/components/ui/badge';
import { MatchScoreBadge } from '@/components/ui/match-signals';
import { initialsFor } from '@/components/employer/ConversationThread';
import { TrustScorePill } from '@/app/[locale]/employer/jobs/[id]/TrustScorePill';
import type { ApplicantOverviewItem } from '@/lib/api/employer';

const MAX_SKILL_BADGES = 4;

/**
 * Availability values the API returns, mapped onto `filters.availability_*`.
 *
 * Duplicated from the module-private `AVAILABILITY_KEYS`/
 * `normalizeAvailabilityKey` in `employer/jobs/[id]/page.tsx:1001-1015` and
 * kept identical, so the same worker's availability reads the same on the
 * per-job list and on this cross-job one. Copied rather than imported because
 * a `page.tsx` is not a module other routes should reach into, and hoisting it
 * would mean editing that page for no behavioural reason.
 *
 * FOLLOW-UP: lift this pair into `@/lib/` (alongside the other display
 * normalizers) the next time either surface is touched, and delete both
 * copies.
 */
const AVAILABILITY_KEYS = new Set([
  'immediate',
  '2weeks',
  '1month',
  'full_time',
  'part_time',
  'weekends',
  'flexible',
]);

function normalizeAvailabilityKey(value: string): string | null {
  const key = value.trim().toLowerCase().replace(/-/g, '_');
  const collapsed = key === '2_weeks' ? '2weeks' : key === '1_month' ? '1month' : key;
  return AVAILABILITY_KEYS.has(collapsed) ? collapsed : null;
}

/**
 * One row of the cross-job applicants dashboard: identity, which job (title ·
 * city — the disambiguator when the same title is posted in several cities),
 * status, the cached match score, and the worker's qualifications.
 *
 * Sprint 24 (B8): the qualifications are the point of the row. The endpoint
 * had been returning availability, years of experience and the trust score all
 * along while this row rendered only a name and four skills, so triaging the
 * cross-job list meant opening every profile. The badges are the same ones the
 * per-job list uses — same component for the trust pill, same label
 * catalogues — so the two surfaces cannot describe a worker differently.
 * Everything deeper still lives on the profile page this row links to.
 */
export function ApplicantOverviewRow({ item }: { item: ApplicantOverviewItem }) {
  const t = useTranslations('employer_applicants');
  const tShared = useTranslations('employer_dashboard');
  const tListing = useTranslations('employer_job_listing');
  const tMatch = useTranslations('match');
  const format = useFormatter();
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  const name = item.worker_name ?? t('unknown_worker');
  const jobLine = item.job_city ? `${item.job_title} · ${item.job_city}` : item.job_title;
  const appliedDate = new Date(item.applied_at);
  const applied = Number.isFinite(appliedDate.getTime())
    ? t('applied_on', { date: format.dateTime(appliedDate, { month: 'short', day: 'numeric' }) })
    : null;
  const availabilityKey = item.availability ? normalizeAvailabilityKey(item.availability) : null;
  // Expanded shows the whole list; collapsed caps it. `hiddenSkills` is the
  // count the toggle names, so it is measured against the CAP either way.
  const hiddenSkills = Math.max(item.skills.length - MAX_SKILL_BADGES, 0);
  const shownSkills = skillsExpanded ? item.skills : item.skills.slice(0, MAX_SKILL_BADGES);

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
        {/* Beside the match badge, not instead of it: they answer two
            different questions -- how well this worker fits THAT job, and how
            they came across when asked about their trade. Renders nothing for
            a null/absent score, so a worker who never took the assessment is
            never labelled "Trust 0". */}
        <TrustScorePill score={item.trust_score ?? null} />
        {availabilityKey ? (
          <Badge tone="neutral">{tListing(`filters.availability_${availabilityKey}`)}</Badge>
        ) : null}
        {item.years_experience !== null ? (
          <Badge tone="neutral">
            <span className="tabular-nums">
              {tShared('worker_profile.years_experience', { years: item.years_experience })}
            </span>
          </Badge>
        ) : null}
        {shownSkills.map((skill) => (
          <Badge key={skill} tone="info">{skill}</Badge>
        ))}
        {/* A real button, not a decorative badge: the old `+1` looked
            interactive, did nothing, and gave no way to see the rest without
            leaving the list. Expands INLINE -- the row is the triage surface,
            and a navigation to read two more words is the thing B8 removes. */}
        {hiddenSkills > 0 ? (
          <button
            type="button"
            aria-expanded={skillsExpanded}
            onClick={() => setSkillsExpanded((open) => !open)}
            className="rounded-full border border-[var(--jale-divider)] px-2 py-0.5 text-[11px] font-semibold text-[var(--jale-ink-2)] transition-colors duration-150 hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {skillsExpanded
              ? t('skills_show_fewer')
              : t('skills_show_all', { count: item.skills.length })}
          </button>
        ) : null}
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
