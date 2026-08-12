'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { MatchReasonChips, MatchScoreBadge } from '@/components/ui/match-signals';
import { Link } from '@/i18n/navigation';
import { formatStartDate } from '@/lib/date';
import type { Job } from '@/lib/api/worker';
import { humanizeReasonCode, normalizeMatchScore, scoreBandForScore, truncateMatchReason } from '@/lib/match';
import { formatPay } from '@/lib/pay';

/**
 * One job in the worker feed — a ROW, not a card.
 *
 * The feed is a single bordered container of divided rows (see
 * `worker/home/page.tsx`), so this component owns no border, no radius and no
 * shadow of its own; it draws the row's interior and lets the list draw the
 * hairline between rows. A stack of individually-boxed cards is what this
 * replaced: at 390px it spent most of the viewport on card chrome and made a
 * ten-job feed read as ten separate surfaces instead of one list.
 *
 * Everything the card showed is still here — title, employer, location, pay,
 * start date, schedule, openings, job type, match band, match reasons and the
 * required-document indicators. Only the paint changed.
 */

const WORKER_REASON_KEYS = new Set([
  'referred_job',
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

const KNOWN_DOC_TYPES = ['resume', 'driver_license', 'ssn'];
const KNOWN_JOB_TYPES = ['full-time', 'part-time', 'contract'];

function jobTypeLabel(t: ReturnType<typeof useTranslations>, type: string) {
  if (KNOWN_JOB_TYPES.includes(type)) return t(`job_type.${type}`);
  return type.replace('-', ' ');
}

/**
 * Meta values separated by a middot. Rendered as one flowing line rather than
 * discrete chips: pay, dates and headcount are facts to skim, not statuses, and
 * giving each its own box was what made the old card five rows tall.
 */
function MetaLine({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <p className="mt-1 text-xs font-medium tabular-nums text-[var(--jale-ink-2)]">
      {items.map((item, index) => (
        <span key={item}>
          {index > 0 ? <span aria-hidden className="px-1.5 opacity-60">·</span> : null}
          {item}
        </span>
      ))}
    </p>
  );
}

export function WorkerJobCard({ job, href }: { job: Job; href: string }) {
  const t = useTranslations('worker_home');
  const tMatch = useTranslations('match');
  const tPay = useTranslations('pay');
  const locale = useLocale();

  const pay = formatPay(job, tPay);
  const matchScore = normalizeMatchScore(job.match_score);
  const scoreBand = matchScore === null ? null : scoreBandForScore(matchScore);
  const matchReasons = (job.match_reasons ?? [])
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
    .slice(0, 3)
    .map((reason) => truncateMatchReason(
      WORKER_REASON_KEYS.has(reason) ? tMatch(`reasons.${reason}`) : humanizeReasonCode(reason),
    ));

  const meta = [
    pay,
    job.start_date ? formatStartDate(job.start_date, locale) ?? job.start_date : null,
    job.shift_schedule ?? null,
    job.open_count != null && job.number_of_workers_needed != null
      ? t('openings_count', { open: job.open_count, total: job.number_of_workers_needed })
      : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const docLabels = job.required_docs.map((doc) =>
    KNOWN_DOC_TYPES.includes(doc) ? t(`doc_labels.${doc}`) : doc,
  );

  return (
    <Link
      href={href}
      className="flex items-start gap-3 px-4 py-4 transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] md:px-5"
    >
      <InitialsAvatar name={job.company_name ?? ''} size={36} square fallback="JB" className="mt-0.5" />

      <div className="min-w-0 flex-1">
        {/* The match band sits on the title line because it is the one signal
            that decides whether the row is worth opening. `shrink-0` keeps it
            whole at 390px and lets the title wrap instead. */}
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-sm font-bold leading-snug text-[var(--jale-ink)]">
            {job.title}
          </p>
          {matchScore !== null && scoreBand ? (
            <span className="mt-0.5 shrink-0">
              <MatchScoreBadge
                score={matchScore}
                band={scoreBand}
                label={tMatch(`score_bands.${scoreBand}`)}
              />
            </span>
          ) : null}
        </div>

        <p className="mt-0.5 text-xs font-medium text-[var(--jale-ink-2)]">
          {job.company_name}
          {job.location ? ` · ${job.location}` : ''}
        </p>

        <MetaLine items={meta} />

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* Job type is a classification, not a state, so it takes the neutral
              dot; success/info/warning stay reserved for the match band. */}
          <Badge tone="neutral">{jobTypeLabel(t, job.job_type)}</Badge>

          {/* Required docs used to be tinted pills. The locked style has no
              tinted status pills, and four coloured dots for four documents
              would out-shout the match band, so they read as a labelled list. */}
          {docLabels.length > 0 ? (
            <p className="min-w-0 text-xs font-medium text-[var(--jale-ink-2)]">
              <span className="font-bold">{t('required_docs_label')}:</span>{' '}
              {docLabels.join(' · ')}
            </p>
          ) : null}
        </div>

        {matchReasons.length > 0 ? (
          <div className="mt-2">
            <MatchReasonChips reasons={matchReasons} />
          </div>
        ) : null}
      </div>
    </Link>
  );
}
