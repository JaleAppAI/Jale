'use client';
import { useTranslations } from 'next-intl';
import {
  progressPercent,
  type RequirementsTotals,
} from '@/lib/application-requirements-flow';

/**
 * "3 left" over "2 details · 1 document · 0 certifications", and a bar.
 *
 * A PERCENTAGE bar rather than `ProgressSegments`, which the onboarding flow
 * uses: that one has a fixed set of named screens to light up, and this does
 * not -- the stepper is three panels but the work is an arbitrary number of
 * fields, docs and certifications, and a worker with one document left should
 * see a nearly-full bar rather than "step 2 of 3".
 *
 * Painted with the same tokens as everything else (`--jale-divider` track,
 * `--jale-success` fill) and given an explicit `progressbar` role with its
 * value, because the numeric line above it is the only other place the state
 * is stated and a bar with no value is decoration.
 */
export function RequirementsProgress({ totals }: { totals: RequirementsTotals }) {
  const t = useTranslations('worker_application_details.progress');
  const percent = progressPercent(totals);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-extrabold text-[var(--jale-ink)]">
          {totals.remainingCount > 0
            ? t('left', { count: totals.remainingCount })
            : t('none_left')}
        </span>
        <span className="text-xs text-[var(--jale-ink-2)]">
          {t('bits', {
            fields: totals.fields.total - totals.fields.done,
            docs: totals.docs.total - totals.docs.done,
            certs: totals.certifications.total - totals.certifications.done,
          })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('aria_label')}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--jale-divider)]"
      >
        <div
          className="h-full rounded-full bg-[var(--jale-success)] transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
