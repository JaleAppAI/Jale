'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { InlineFeedback } from '@/components/ui/inline-feedback';

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
 * `details_requested` badge tone in `lib/status.ts`) and its `role="status"`
 * politeness, which is right here: this is standing page state a worker
 * arrives to, not an event that just fired at them. The prototype draws a
 * heavier custom banner; the existing component wins.
 *
 * `remainingCount` is optional because only some callers know it -- the list
 * rows carry `remaining_count`, the home banner does not. When it is absent
 * the banner says why it is here without claiming a number it cannot back up.
 */
export function DetailsRequestedBanner({
  applicationId,
  companyName,
  remainingCount,
  compact = false,
}: {
  applicationId: string;
  companyName?: string | null;
  remainingCount?: number;
  /** Row-level variant: tighter, no heading line. */
  compact?: boolean;
}) {
  const t = useTranslations('worker_applications.details_banner');

  const body = companyName
    ? t('row_body', { company: companyName })
    : t('one_head');

  return (
    <InlineFeedback tone="warning">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0">
          {!compact ? (
            <span className="block font-semibold text-[var(--jale-ink)]">{t('one_head')}</span>
          ) : null}
          {remainingCount !== undefined && remainingCount > 0 ? (
            <span className="block font-semibold text-[var(--jale-ink)]">
              {t('row_left', { count: remainingCount })}
            </span>
          ) : null}
          <span className="block">{body}</span>
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
