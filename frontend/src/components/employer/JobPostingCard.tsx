'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { JobStatusBadge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { formatShortDate } from '@/lib/date';
import type { Job } from '@/lib/api/employer';

interface Props {
  job: Job;
  href: string;
  onDelete?: (job: Job) => void;
  /**
   * Pause an ACTIVE job / resume a PAUSED one, in place on the board.
   *
   * Both are optional and independently so: a caller that wires neither gets
   * exactly the row it got before. The dashboard wires both, because pausing
   * is the self-service way out of the active-job limit and the limit dialog's
   * own "Pause another job" CTA points at the board -- which, before this,
   * offered no way to pause anything.
   */
  onPause?: (job: Job) => void;
  onResume?: (job: Job) => void;
  /** A status change for THIS row is in flight; freezes its control and relabels it. */
  statusPending?: boolean;
  /**
   * A status change for SOME row is in flight; freezes this control too.
   *
   * Two props rather than one because they answer different questions: only
   * the row being changed should say "Pausing…", but no row should be
   * clickable while a PATCH is open. The caller serialises status changes (one
   * at a time, mirroring `employer/jobs/[id]/page.tsx`), and a control that
   * silently does nothing when clicked is worse than one that looks disabled.
   */
  statusBusy?: boolean;
}

/**
 * One job posting, rendered as a ROW of the dashboard's postings list.
 *
 * It renders its own `<li>` and draws no border of its own: the list is a
 * `<ul class="divide-y">` inside a single bordered `DashboardPanel`, so the
 * hairlines belong to the list, not to each card. That is what retired the old
 * `isLast` prop — a row should not have to know where it sits to look right.
 *
 * The `@container` wrapper is deliberate and stays. The row reacts to its OWN
 * available width (the postings panel's real width, which shrinks when the
 * dashboard's two-panel split engages) rather than the viewport's. A viewport
 * breakpoint cannot express this: once the split is active, panel width is a
 * non-monotonic function of viewport width, so any single `xl:`-style
 * breakpoint either fires while the columns are still too narrow (the title
 * wraps word-by-word) or never fires with enough room to matter.
 *
 * The THRESHOLD, however, was wrong. Measured on the real dashboard, this
 * container is 741px at a 1440px viewport and 890px at 1920px — the page caps
 * at `max-w-[1380px]`, so it never gets much wider. The old `@[800px]` query
 * therefore only fired above roughly a 1750px viewport, and every ordinary
 * desktop got the stacked mobile layout. It fires at 600px now, over a row
 * built from four columns instead of seven: location, posted date and pay read
 * as one metadata line under the title (they are all "about this posting"),
 * which both fits the real width and gives the 390px stack four short lines
 * instead of eight.
 */
export function JobPostingCard({
  job, href, onDelete, onPause, onResume, statusPending = false, statusBusy = false,
}: Props) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();

  /*
   * Which direction this row can move, if any.
   *
   * Only the two reversible states get a control: `filled` and `closed` are
   * terminal as far as this board is concerned (reopening a closed job is a
   * decision with consequences -- applicants, public listing -- and belongs on
   * the job's own page, which has the room to say so).
   */
  const statusAction: { key: 'pause' | 'resume'; run: (job: Job) => void } | null =
    job.status === 'active' && onPause
      ? { key: 'pause', run: onPause }
      : job.status === 'paused' && onResume
        ? { key: 'resume', run: onResume }
        : null;

  const openCount =
    job.open_count ?? Math.max(0, (job.number_of_workers_needed ?? 0) - (job.hired_count ?? 0));

  const postedDate = formatShortDate(job.created_at, locale) ?? job.created_at;

  const pay =
    job.pay ??
    (job.pay_min !== null || job.pay_max !== null
      ? t('jobs.pay_range_value', { min: job.pay_min ?? 0, max: job.pay_max ?? 0 })
      : null);

  const meta = [job.location, `${t('jobs.posted')} ${postedDate}`, pay]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="@container">
      <div className="grid grid-cols-1 items-start gap-2 px-4 py-4 transition-colors duration-150 hover:bg-[var(--jale-paper-2)] md:px-5 @[600px]:grid-cols-[minmax(0,1fr)_auto_auto_auto] @[600px]:items-center @[600px]:gap-4">
        <div className="min-w-0">
          <Link
            href={href}
            className="inline-block rounded text-sm font-bold leading-snug text-[var(--jale-ink)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {job.title}
          </Link>
          <p className="mt-0.5 text-xs font-medium tabular-nums text-[var(--jale-ink-2)]">{meta}</p>
        </div>

        <p className="text-xs font-semibold tabular-nums text-[var(--jale-ink)] @[600px]:whitespace-nowrap @[600px]:text-right">
          {t('jobs.openings_count', { open: openCount, total: job.number_of_workers_needed })}
          <span aria-hidden className="px-1.5 text-[var(--jale-ink-2)]">
            ·
          </span>
          {t('jobs.applicants_count', { count: job.applicant_count })}
        </p>

        <JobStatusBadge status={job.status}>{t(`jobs.status.${job.status}`)}</JobStatusBadge>

        <div className="flex items-center gap-1.5">
          <Link
            href={href}
            className="inline-flex h-9 items-center justify-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4 text-xs font-semibold text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {t('jobs.details')}
          </Link>

          {statusAction ? (
            <button
              type="button"
              // Named like Delete's: a column of identical "Pause" buttons is
              // unusable to anyone tabbing through the board.
              aria-label={t(`jobs.status_change.${statusAction.key}_aria`, { title: job.title })}
              disabled={statusPending || statusBusy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                statusAction.run(job);
              }}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4 text-xs font-semibold text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-50"
            >
              {statusPending
                ? t(`jobs.status_change.${statusAction.key}_pending`)
                : t(`jobs.status_change.${statusAction.key}`)}
            </button>
          ) : null}

          {onDelete ? (
            <button
              type="button"
              // The generic "Delete" is the tooltip; the accessible name names
              // the job, because a list of identical "Delete" buttons is
              // unusable to anyone tabbing through it.
              aria-label={t('jobs.delete.button_aria', { title: job.title })}
              title={t('jobs.delete.button')}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(job);
              }}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-danger-bg)] hover:text-[var(--jale-danger)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <Icon name="trash" />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
