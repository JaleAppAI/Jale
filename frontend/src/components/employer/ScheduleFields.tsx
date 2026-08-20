'use client';
import { useTranslations } from 'next-intl';
import { WORK_DAYS, type WorkDay } from '@/lib/job-form';
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
 */
interface ScheduleFieldsProps {
  workDays: string[];
  shiftStart: string;
  shiftEnd: string;
  legacyShiftSchedule: string;
  onToggleDay: (day: WorkDay) => void;
  onShiftStartChange: (value: string) => void;
  onShiftEndChange: (value: string) => void;
  disabled?: boolean;
}

export function ScheduleFields({
  workDays, shiftStart, shiftEnd, legacyShiftSchedule,
  onToggleDay, onShiftStartChange, onShiftEndChange, disabled,
}: ScheduleFieldsProps) {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');

  const showLegacyNote =
    workDays.length === 0 && shiftStart === '' && shiftEnd === '' && legacyShiftSchedule.trim() !== '';

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

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('modal.shift_start_label')}
          </label>
          <Input
            type="time"
            value={shiftStart}
            onChange={(e) => onShiftStartChange(e.target.value)}
            disabled={disabled}
          />
        </div>
        <span className="pb-2.5 text-xs font-semibold text-[var(--jale-ink-2)]">{t('modal.shift_to')}</span>
        <div className="flex min-w-[8rem] flex-1 flex-col gap-1.5">
          <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
            {t('modal.shift_end_label')}
          </label>
          <Input
            type="time"
            value={shiftEnd}
            onChange={(e) => onShiftEndChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>

      {showLegacyNote && (
        <p className="text-xs text-[var(--jale-ink-2)]">
          {t('modal.legacy_value_note', { value: legacyShiftSchedule })}
        </p>
      )}
    </div>
  );
}
