'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { formatStartDateWeekdayShort } from '@/lib/date';
import type { ApplicationHire } from '@/lib/api/worker';

/**
 * "You got the job" — what stays on screen after the celebration modal has
 * been closed.
 *
 * ONE component for both places it appears (the worker home, and under the
 * hired row of the applications list), for the same reason
 * `DetailsRequestedBanner` is one component in three places: the sentence, the
 * tone and the destination cannot be allowed to drift between the two screens
 * a worker will compare within the same minute.
 *
 * BUILT ON `InlineFeedback tone="success"`, not a bespoke green card. That
 * component already owns the success palette (`--jale-success*`, the same tint
 * the `hired` chip uses in `lib/status.ts`) and its `role="status"`
 * politeness, which is exactly right here: by the time this renders the modal
 * has already interrupted once, and what is left is standing page state a
 * worker arrives to — not an event firing at them again on every visit.
 *
 * The dismissal is NOT this component's business. It calls `onDismiss` and the
 * page decides what that means (a `hire-ack` receipt plus an optimistic
 * removal); the banner has no idea a server is involved, which is what lets
 * the same one sit in a list row and on a page header.
 */
export function HiredBanner({
  applicationId,
  jobTitle,
  companyName,
  hire,
  compact = false,
  onDismiss,
}: {
  applicationId: string;
  jobTitle: string;
  companyName: string;
  hire: ApplicationHire;
  /** Row-level variant: no heading, no link — the row above already has both. */
  compact?: boolean;
  onDismiss: () => void;
}) {
  const t = useTranslations('worker_applications.hired_celebration');
  const locale = useLocale();

  // Date-only value, so the UTC-pinned formatter: `formatLongDate` here would
  // print the day before for any reader west of Greenwich.
  const startDate = formatStartDateWeekdayShort(hire.start_date, locale);

  return (
    <InlineFeedback tone="success" onDismiss={onDismiss} dismissLabel={t('banner.dismiss')}>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* The prototype's glyph, not `Icon name="check"`: the shared Icon is
            a fixed 18x18 and would fill this 22px disc edge to edge. */}
        <span
          aria-hidden
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--jale-success)] text-[12px] font-extrabold leading-none text-white"
        >
          ✓
        </span>

        <span className="min-w-0 flex-1">
          {compact ? (
            /* The row states the job, the company and the Hired chip already.
               Repeating them under it would read as a second, different hire. */
            <span className="block">{t('row.body')}</span>
          ) : (
            <>
              <span className="block font-bold text-[var(--jale-ink)]">
                {t('banner.title', { title: jobTitle, company: companyName })}
              </span>
              {/* Two whole sentences rather than one with an optional clause:
                  "Starts null" and "Starts  ·" are both worse than saying
                  plainly that the employer has not set a date yet. */}
              <span className="block">
                {startDate
                  ? t('banner.body_dated', { date: startDate })
                  : t('banner.body_undated')}
              </span>
            </>
          )}
        </span>

        {compact ? null : (
          <Link
            href={`/worker/applications/${applicationId}`}
            className="shrink-0 rounded-[var(--radius-input)] bg-[var(--jale-ink)] px-3 py-1.5 text-xs font-bold text-[var(--jale-paper)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {t('banner.cta')}
          </Link>
        )}
      </span>
    </InlineFeedback>
  );
}
