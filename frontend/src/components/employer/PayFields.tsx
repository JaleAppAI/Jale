'use client';
import type React from 'react';
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { PAY_INTERVALS, payRangeExceeds, type JobForm, type PayInterval } from '@/lib/job-form';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * Pay min/max/interval, with a LIVE inline range error (job-flow redesign,
 * FE-T6): `payRangeExceeds` runs on every render, not just on submit, so the
 * "min cannot be greater than max" message appears the moment it becomes
 * true while typing and disappears the moment it stops being true --
 * `validateJobNumbers`/`validateStepDetails` still run the same check at
 * submit/step-advance time as the authoritative gate, this is purely the
 * earlier, friendlier surfacing of the same rule.
 *
 * The max carries a standing hint that it is optional (pay can be negotiable),
 * and every label is tied to its control so each input has a name.
 */
interface PayFieldsProps {
  payMin: string;
  payMax: string;
  payInterval: PayInterval;
  onPayMinChange: (value: string) => void;
  onPayMaxChange: (value: string) => void;
  onPayIntervalChange: (value: PayInterval) => void;
  disabled?: boolean;
  /**
   * The pay field a refused step is about. `message: null` marks it without a
   * second sentence -- the live range error below already says it.
   */
  fieldError?: { field: 'pay_min' | 'pay_max'; message: string | null } | null;
}

export function PayFields({
  payMin, payMax, payInterval, onPayMinChange, onPayMaxChange, onPayIntervalChange, disabled,
  fieldError,
}: PayFieldsProps) {
  const t = useTranslations('employer_dashboard');
  const rangeInvalid = payRangeExceeds(payMin, payMax);
  const minId = useId();
  const maxId = useId();
  const intervalId = useId();
  const maxHintId = useId();
  const rangeErrorId = useId();
  const fieldErrorId = useId();
  const minMarked = fieldError?.field === 'pay_min';
  const maxMarked = fieldError?.field === 'pay_max';
  const describe = (...ids: Array<string | false>) => ids.filter(Boolean).join(' ') || undefined;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('modal.pay_min')} htmlFor={minId}>
          <Input
            id={minId}
            data-field="pay_min"
            type="number"
            min={0}
            className="tabular-nums"
            value={payMin}
            onChange={(e) => onPayMinChange(e.target.value)}
            disabled={disabled}
            aria-invalid={rangeInvalid || minMarked || undefined}
            aria-describedby={describe(rangeInvalid && rangeErrorId, minMarked && !!fieldError?.message && fieldErrorId)}
          />
          {minMarked && fieldError?.message && <FieldMessage id={fieldErrorId}>{fieldError.message}</FieldMessage>}
        </Field>
        <Field label={t('modal.pay_max')} htmlFor={maxId}>
          <Input
            id={maxId}
            data-field="pay_max"
            type="number"
            min={0}
            className="tabular-nums"
            placeholder={t('modal.pay_max_placeholder')}
            value={payMax}
            onChange={(e) => onPayMaxChange(e.target.value)}
            disabled={disabled}
            aria-invalid={rangeInvalid || maxMarked || undefined}
            aria-describedby={describe(maxHintId, rangeInvalid && rangeErrorId, maxMarked && !!fieldError?.message && fieldErrorId)}
          />
          {maxMarked && fieldError?.message && <FieldMessage id={fieldErrorId}>{fieldError.message}</FieldMessage>}
          <p id={maxHintId} className="text-xs text-[var(--jale-ink-2)]">{t('modal.pay_max_hint')}</p>
        </Field>
      </div>
      {rangeInvalid && (
        <p id={rangeErrorId} role="alert" className="-mt-2 text-xs font-semibold text-[var(--jale-danger)]">
          {t('modal.validation_pay_range')}
        </p>
      )}
      <Field label={t('modal.pay_interval')} htmlFor={intervalId}>
        <Select
          id={intervalId}
          value={payInterval}
          onChange={(e) => onPayIntervalChange(e.target.value as JobForm['pay_interval'])}
          disabled={disabled}
        >
          {PAY_INTERVALS.map((interval) => (
            <option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function FieldMessage({ id, children }: { id: string; children: React.ReactNode }) {
  return <p id={id} className="text-xs font-medium text-[var(--jale-danger-text)]">{children}</p>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</label>
      {children}
    </div>
  );
}
