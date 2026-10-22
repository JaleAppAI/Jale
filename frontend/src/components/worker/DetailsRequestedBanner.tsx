'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { RequirementsRemaining } from '@/lib/api/worker';

/**
 * "An employer is waiting on you." The one thing the worker app interrupts for.
 *
 * It renders in three places -- the home page, each `details_requested` row of
 * the applications list, and the job detail page once applied -- and it is the
 * SAME component in all three so the sentence, the tone and the destination
 * cannot drift between them. The prototype (W3b/W3c/W3d) shows exactly that:
 * one amber block, one "Complete details" button, the employer named.
 *
 * BUILT ON `InlineFeedback tone="warning"`, not a bespoke amber card. That
 * component already owns the warning palette (`--jale-warning*`, matching the
 * `details_requested` badge tone in `lib/status.ts`), and its `feedbackRole`
 * maps that tone to `role="alert"` (see `ui/inline-feedback.tsx`) -- which is
 * right here. An employer waiting on this worker is not decoration they can
 * find later: it is the one thing the app interrupts for, so a screen-reader
 * user should hear it on arrival rather than only on reaching it in reading
 * order. `alert` announces the region once, assertively, and the banner is
 * rendered as part of the page rather than injected repeatedly, so it says its
 * sentence a single time. The prototype draws a heavier custom banner; the
 * existing component wins.
 *
 * `remainingCount` is optional because only some callers know it -- the list
 * rows carry `remaining_count`, the home banner does not. When it is absent
 * the banner says why it is here without claiming a number it cannot back up.
 *
 * WHAT IS ASKED, AND HOW LONG IT TAKES. A caller holding the request's own
 * `counts` (a list row, the job page) gets a short list in its place -- "2
 * questions · 1 document" -- where questions are the employer's prompts and
 * fields together, because to the worker both are questions to answer. Every
 * banner ends with "About 5 min", the W3 estimate, so a worker knows the cost
 * before opening it.
 */
export function DetailsRequestedBanner({
  applicationId,
  companyName,
  remainingCount,
  counts,
  compact = false,
}: {
  applicationId: string;
  companyName?: string | null;
  remainingCount?: number;
  /** The request's own counts, when the caller has them; wins over `remainingCount`. */
  counts?: RequirementsRemaining['counts'];
  /** Row-level variant: tighter, no heading line. */
  compact?: boolean;
}) {
  const t = useTranslations('worker_applications.details_banner');

  const body = companyName
    ? t('row_body', { company: companyName })
    : t('one_head');

  const questions = counts ? counts.prompts + counts.fields : 0;
  const items = counts
    ? [
      questions > 0 ? t('items.questions', { count: questions }) : null,
      counts.certifications > 0 ? t('items.certifications', { count: counts.certifications }) : null,
      counts.docs > 0 ? t('items.documents', { count: counts.docs }) : null,
    ].filter((item): item is string => item !== null)
    : [];
  const summary = items.length > 0
    ? items
    : remainingCount !== undefined && remainingCount > 0
      ? [t('row_left', { count: remainingCount })]
      : [];

  return (
    <InlineFeedback tone="warning">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0">
          {!compact ? (
            <span className="block font-semibold text-[var(--jale-ink)]">{t('one_head')}</span>
          ) : null}
          <span className="block">{body}</span>
          {/* One line: what is asked, then the time it takes. */}
          <span className="block font-semibold text-[var(--jale-ink)]">
            {[...summary, t('about_time')].map((part, index) => (
              <span key={part}>
                {index > 0 ? <span aria-hidden="true">{' · '}</span> : null}
                <span>{part}</span>
              </span>
            ))}
          </span>
        </span>
        <Link
          href={`/worker/applications/${applicationId}`}
          className="shrink-0 rounded-[var(--radius-input)] bg-[var(--jale-ink)] px-3 py-1.5 text-xs font-bold text-[var(--jale-paper)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {t('one_cta')}
        </Link>
      </span>
    </InlineFeedback>
  );
}

/**
 * The top-of-page banner for MORE THAN ONE waiting application. A separate
 * component rather than a mode of the one above, because it names no employer
 * and links to the list rather than to a specific application -- nothing about
 * its content is shared beyond the tone.
 */
export function DetailsRequestedMultiBanner({
  count,
  onList = false,
}: {
  count: number;
  /** On the applications list itself there is nowhere to send them. */
  onList?: boolean;
}) {
  const t = useTranslations('worker_applications.details_banner');

  return (
    <InlineFeedback tone="warning">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0">
          <span className="block font-semibold text-[var(--jale-ink)]">
            {t('many_head', { count })}
          </span>
          <span className="block">{onList ? t('multi_body') : t('many_body', { count })}</span>
        </span>
        {onList ? null : (
          <Link
            href="/worker/applications"
            className="shrink-0 rounded-[var(--radius-input)] bg-[var(--jale-ink)] px-3 py-1.5 text-xs font-bold text-[var(--jale-paper)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            {t('many_cta')}
          </Link>
        )}
      </span>
    </InlineFeedback>
  );
}
