'use client';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/icon';

const MIN_YEARS = 0;
const MAX_YEARS = 20;

/** Clamp to the stepper's closed range, treating blank/non-numeric as 0. */
function clamp(raw: string): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MIN_YEARS;
  return Math.min(MAX_YEARS, Math.max(MIN_YEARS, n));
}

/**
 * Required-years-of-experience stepper (job-flow redesign, FE-T6, locked
 * decision: "numeric stepper 0-20, 0 shows 'No experience required'").
 *
 * Unlike the legacy free-text-shaped number input, this control has no
 * "unset" state of its own -- `form.required_experience_years` starts as
 * `''` (see `initialForm`), which this component treats identically to `0`
 * for display, and every +/- click writes back a definite integer string.
 * `validateJobNumbers` is unaffected either way: blank and `'0'` both pass
 * its `experience !== null && experience < 0` check.
 */
interface ExperienceStepperProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ExperienceStepper({ value, onChange, disabled }: ExperienceStepperProps) {
  const t = useTranslations('employer_dashboard');
  const years = clamp(value === '' ? '0' : value);

  const step = (delta: number) => {
    const next = Math.min(MAX_YEARS, Math.max(MIN_YEARS, years + delta));
    onChange(String(next));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {t('modal.experience_years_label')}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={t('modal.experience_decrement_aria')}
          disabled={disabled || years <= MIN_YEARS}
          onClick={() => step(-1)}
          className={[
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--jale-divider)]',
            'bg-[var(--jale-card)] text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
          ].join(' ')}
        >
          <Icon name="minus" />
        </button>
        <span className="w-8 text-center text-lg font-extrabold tabular-nums text-[var(--jale-ink)]" aria-hidden>
          {years}
        </span>
        <button
          type="button"
          aria-label={t('modal.experience_increment_aria')}
          disabled={disabled || years >= MAX_YEARS}
          onClick={() => step(1)}
          className={[
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--jale-divider)]',
            'bg-[var(--jale-card)] text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
          ].join(' ')}
        >
          <Icon name="plus" />
        </button>
        <span className="text-sm font-medium text-[var(--jale-ink-2)]" role="status">
          {years === 0 ? t('modal.experience_none') : t('modal.experience_years', { n: years })}
        </span>
      </div>
    </div>
  );
}
