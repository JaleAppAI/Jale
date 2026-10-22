'use client';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { SHIFT_PERIODS, WORK_DAYS, type ShiftPeriod, type WorkDay } from '@/lib/job-form';
import { CheckboxCard } from '@/components/ui/checkbox-card';
import { Input } from '@/components/ui/input';

/**
 * Structured schedule input (job-flow redesign, FE-T6): seven day-toggle
 * pills over `WORK_DAYS` plus two native `type="time"` inputs for shift
 * start/end. No wraparound or range-formatting logic lives here -- that is
 * `lib/job-form.ts`'s job (`deriveLegacyShiftSchedule`); this component only
 * ever hands back the raw day list and 'HH:MM' strings the browser gives it.
 *
 * `legacyShiftSchedule` is the pre-redesign free-text value a loaded job may
 * still carry (see `jobToForm`). It stays in form state and still feeds the
 * payload whenever no structured value is set (`jobFormToBasePayload`), but
 * the free-text INPUT is gone from this surface -- so a legacy value would
 * otherwise become invisible. Showing it as a read-only note keeps it from
 * silently disappearing on the employer while they fill in the new fields.
 *
 * Shift choices (contract K2): Day / Evening / Night / Overnight, several at
 * once, each with its one-line help, as `CheckboxCard`s in a fieldset. The
 * start and end times sit under them and are labelled optional: a shift
 * choice never needs times, and times never need a shift choice.
 */
interface ScheduleFieldsProps {
  workDays: string[];
  shiftStart: string;
  shiftEnd: string;
  legacyShiftSchedule: string;
  onToggleDay: (day: WorkDay) => void;
  onShiftStartChange: (value: string) => void;
  onShiftEndChange: (value: string) => void;
  shiftPeriods: ShiftPeriod[];
  onToggleShiftPeriod: (period: ShiftPeriod) => void;
  disabled?: boolean;
  /** The time field a refused step is about, with the sentence shown under the times. */
  fieldError?: { field: 'shift_start' | 'shift_end'; message: string } | null;
}

export function ScheduleFields({
  workDays, shiftStart, shiftEnd, legacyShiftSchedule,
  onToggleDay, onShiftStartChange, onShiftEndChange,
  shiftPeriods, onToggleShiftPeriod, disabled, fieldError,
}: ScheduleFieldsProps) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const shiftsHintId = useId();
  const timesHintId = useId();
  const startId = useId();
  const endId = useId();
  const timeErrorId = useId();
  const startMarked = fieldError?.field === 'shift_start';
  const endMarked = fieldError?.field === 'shift_end';

  const showLegacyNote =
    workDays.length === 0 && shiftPeriods.length === 0 && shiftStart === '' && shiftEnd === ''
    && legacyShiftSchedule.trim() !== '';

  return (
    <div className="grid gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('modal.schedule_days_label')}
        </label>
        <p className="text-xs text-[var(--jale-ink-2)]">{t('modal.schedule_days_hint')}</p>
        <div className="flex flex-wrap gap-2">
          {WORK_DAYS.map((day) => {
            const selected = workDays.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => onToggleDay(day)}
                className={[
                  'rounded-full border px-3.5 py-2 text-xs font-bold transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  selected
                    ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                    : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
                ].join(' ')}
              >
                {tCommon(`work_days.${day}`)}
              </button>
            );
          })}
        </div>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" aria-describedby={shiftsHintId}>
        <legend className="mb-1.5 p-0 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('modal.shifts_label')}
        </legend>
        <p id={shiftsHintId} className="text-xs text-[var(--jale-ink-2)]">{t('modal.shifts_hint')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {SHIFT_PERIODS.map((period) => (
            <CheckboxCard
              key={period}
              checked={shiftPeriods.includes(period)}
              label={tCommon(`shift_periods.${period}`)}
              description={tCommon(`shift_period_help.${period}`)}
              onChange={() => onToggleShiftPeriod(period)}
              disabled={disabled}
            />
          ))}
        </div>
      </fieldset>

      <p className="-mb-1.5 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {t('modal.shift_times_label')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5">
          <label htmlFor={startId} className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('modal.shift_start_label')}
          </label>
          <Input
            id={startId}
            data-field="shift_start"
            type="time"
            aria-invalid={startMarked || undefined}
            aria-describedby={startMarked ? `${timesHintId} ${timeErrorId}` : timesHintId}
            value={shiftStart}
            onChange={(e) => onShiftStartChange(e.target.value)}
            disabled={disabled}
          />
        </div>
        <span className="pb-2.5 text-xs font-semibold text-[var(--jale-ink-2)]">{t('modal.shift_to')}</span>
        <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5">
          <label htmlFor={endId} className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('modal.shift_end_label')}
          </label>
          <Input
            id={endId}
            data-field="shift_end"
            type="time"
            aria-invalid={endMarked || undefined}
            aria-describedby={endMarked ? `${timesHintId} ${timeErrorId}` : timesHintId}
            value={shiftEnd}
            onChange={(e) => onShiftEndChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>
      {fieldError && (
        <p id={timeErrorId} className="-mt-1.5 text-xs font-medium text-[var(--jale-danger-text)]">{fieldError.message}</p>
      )}
      <p id={timesHintId} className="-mt-1.5 text-xs text-[var(--jale-ink-2)]">{t('modal.shift_times_hint')}</p>

      {showLegacyNote && (
        <p className="text-xs text-[var(--jale-ink-2)]">
          {t('modal.legacy_value_note', { value: legacyShiftSchedule })}
        </p>
      )}
    </div>
  );
}
