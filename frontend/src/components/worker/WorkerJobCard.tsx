'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { MatchReasonChips, MatchScoreBadge } from '@/components/ui/match-signals';
import { Link } from '@/i18n/navigation';
import { formatStartDate } from '@/lib/date';
import type { Job } from '@/lib/api/worker';
import { humanizeReasonCode, normalizeMatchScore, scoreBandForScore, truncateMatchReason } from '@/lib/match';

const WORKER_REASON_KEYS = new Set([
  'profession_exact_or_alias',
  'profession_partial',
  'distance_under_5_miles',
  'distance_under_15_miles',
  'distance_under_30_miles',
  'distance_under_50_miles',
  'zip_exact',
  'location_text_match',
  'experience_meets_requirement',
  'availability_flexible',
  'availability_matches_job_type',
  'availability_adjacent',
  'fresh_posting',
]);

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  driver_license: "Driver's License",
  // SSN is no longer offered for new jobs, but legacy jobs may still require it — keep the label.
  ssn: 'SSN Card / ITIN',
};

function jobTypeLabel(type: string) {
  if (type === 'full-time') return '40 hrs/wk';
  if (type === 'part-time') return 'Part-time';
  return type.replace('-', ' ');
}

function getInitials(name: string) {
  return name.split(/\s+/).map((word) => word[0]).join('').toUpperCase().slice(0, 2);
}

export function WorkerJobCard({ job, href }: { job: Job; href: string }) {
  const t = useTranslations('worker_home');
  const tMatch = useTranslations('match');
  const locale = useLocale();
  const initials = getInitials(job.company_name ?? 'JB');
  const pay = job.pay && job.pay !== 'Pay not specified' ? job.pay : null;
  const matchScore = normalizeMatchScore(job.match_score);
  const scoreBand = matchScore === null ? null : scoreBandForScore(matchScore);
  const matchReasons = (job.match_reasons ?? [])
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
    .slice(0, 3)
    .map((reason) => truncateMatchReason(
      WORKER_REASON_KEYS.has(reason) ? tMatch(`reasons.${reason}`) : humanizeReasonCode(reason),
    ));

  return (
    <Link href={href} className="block">
      <Card
        className="p-4 flex gap-3 items-start transition-shadow hover:shadow-md"
        style={{ cursor: 'pointer' }}
      >
        <span
          className="avatar-initials square flex-shrink-0"
          style={{ width: 44, height: 44, fontSize: 15, background: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)', borderRadius: 12 }}
        >
          {initials}
        </span>

        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-snug" style={{ fontSize: 14, color: 'var(--jale-ink)' }}>
            {job.title}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--jale-ink-2)' }}>
            {job.company_name}
            {job.location ? ` - ${job.location}` : ''}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5 text-xs" style={{ color: 'var(--jale-ink-2)' }}>
            {pay && <span>{pay}</span>}
            {job.start_date && <span>{formatStartDate(job.start_date, locale) ?? job.start_date}</span>}
            {job.shift_schedule && <span>{job.shift_schedule}</span>}
            {job.open_count != null && job.number_of_workers_needed != null && (
              <span>{t('openings_count', { open: job.open_count, total: job.number_of_workers_needed })}</span>
            )}
          </div>

          {job.required_docs.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {job.required_docs.map((doc) => (
                <span
                  key={doc}
                  className="pill pill-info"
                  style={{ fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}
                >
                  {DOC_LABELS[doc] ?? doc}
                </span>
              ))}
            </div>
          )}

          {matchReasons.length > 0 && (
            <div className="mt-2">
              <MatchReasonChips reasons={matchReasons} />
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {matchScore !== null && scoreBand && (
            <MatchScoreBadge
              score={matchScore}
              band={scoreBand}
              label={tMatch(`score_bands.${scoreBand}`)}
            />
          )}
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize"
            style={{ background: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)' }}
          >
            {jobTypeLabel(job.job_type)}
          </span>
        </div>
      </Card>
    </Link>
  );
}
