'use client';
import { useTranslations } from 'next-intl';
import { DURATION_BUCKETS, type DurationBucket } from '@/lib/job-form';

/**
 * Expected-duration preset buttons (job-flow redesign, FE-T6, locked
 * decision: "Expected Duration = preset buckets incl. Ongoing/Permanent").
 * Single-select over `DURATION_BUCKETS` -- clicking the already-selected
 * bucket clears it back to unset, same toggle-off affordance as the
 * work-days pills.
 *
 * `legacyExpectedDuration` is the pre-redesign free-text value (see
 * `ScheduleFields`'s identical rationale for `legacyShiftSchedule`): it stays
 * in form state and still feeds the payload when no bucket is picked
 * (`jobFormToBasePayload`), but with the free-text input gone from this
 * surface, a loaded legacy job needs some way to show it wasn't lost.
 */
interface DurationFieldProps {
  value: '' | DurationBucket;
  legacyExpectedDuration: string;
  onChange: (value: '' | DurationBucket) => void;
  disabled?: boolean;
}

export function DurationField({ value, legacyExpectedDuration, onChange, disabled }: DurationFieldProps) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');

  const showLegacyNote = value === '' && legacyExpectedDuration.trim() !== '';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {t('modal.expected_duration')}
      </label>
      <div className="flex flex-wrap gap-2">
        {DURATION_BUCKETS.map((bucket) => {
          const selected = value === bucket;
          return (
            <button
              key={bucket}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(selected ? '' : bucket)}
              className={[
                'rounded-full border px-3.5 py-2 text-xs font-bold transition-colors',
                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                  : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
              ].join(' ')}
            >
              {tCommon(`duration_bucket.${bucket}`)}
            </button>
          );
        })}
      </div>
      {showLegacyNote && (
        <p className="text-xs text-[var(--jale-ink-2)]">
          {t('modal.legacy_value_note', { value: legacyExpectedDuration })}
        </p>
      )}
    </div>
  );
}
