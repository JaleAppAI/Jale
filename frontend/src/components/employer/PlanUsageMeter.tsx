'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import type { EmployerBilling } from '@/lib/api/employer';

/**
 * "Active jobs 2/3 · Templates 1/1 · View plan" — the standing answer to "how
 * much of my plan am I using", sitting beside the count it qualifies.
 *
 * Two rules it exists to keep:
 *
 *  - It NEVER prints "0/0". A meter is a claim about the account, and a plan
 *    whose limits have not arrived yet supports no claim; that state is a
 *    skeleton, the same treatment the templates page gives its own meter.
 *  - `activeCount` comes from the jobs list the page already renders, not from
 *    `billing.activeJobUsage`. The list is what a post or a delete updates, so
 *    the meter stays truthful without a second round-trip to billing.
 *
 * A billing fetch that failed degrades to the plain count rather than hiding:
 * "3 active jobs" is still true, and still useful.
 */
export function PlanUsageMeter({
  activeCount,
  billing,
  templateCount,
  loading = false,
}: {
  activeCount: number;
  billing: EmployerBilling | null;
  templateCount: number | null;
  loading?: boolean;
}) {
  const t = useTranslations('employer_dashboard');

  // A <div>, not a <span>: the loading branch nests a Skeleton block inside it.
  // `inline-flex` renders identically either way inside the row's flex parent.
  const wrapper = 'inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tabular-nums text-[var(--jale-ink-2)]';

  if (loading) {
    return (
      <div className={wrapper}>
        <Skeleton className="h-3.5 w-40" />
      </div>
    );
  }

  if (billing === null) {
    return <div className={wrapper}>{t('usage.jobs_plain', { used: activeCount })}</div>;
  }

  // `>=`, not `===`: a plan whose limit was lowered can leave an employer above
  // it, and that employer is the one who most needs the segment to stand out.
  const atJobLimit = activeCount >= billing.activeJobLimit;
  const atTemplateLimit = templateCount !== null && templateCount >= billing.templateLimit;
  const warn = 'text-[var(--jale-warning-text)]';

  return (
    <div className={wrapper}>
      <span className={atJobLimit ? warn : undefined}>
        {t('usage.jobs', { used: activeCount, limit: billing.activeJobLimit })}
      </span>

      {templateCount !== null ? (
        <>
          <span aria-hidden="true">·</span>
          <span className={atTemplateLimit ? warn : undefined}>
            {t('usage.templates', { used: templateCount, limit: billing.templateLimit })}
          </span>
        </>
      ) : null}

      <span aria-hidden="true">·</span>
      <Link
        href="/employer/billing"
        className="rounded font-bold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {t('usage.view_plan')}
      </Link>
    </div>
  );
}
