'use client';
import type React from 'react';
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
 */
interface PayFieldsProps {
  payMin: string;
  payMax: string;
  payInterval: PayInterval;
  onPayMinChange: (value: string) => void;
  onPayMaxChange: (value: string) => void;
  onPayIntervalChange: (value: PayInterval) => void;
  disabled?: boolean;
}

export function PayFields({
  payMin, payMax, payInterval, onPayMinChange, onPayMaxChange, onPayIntervalChange, disabled,
}: PayFieldsProps) {
  const t = useTranslations('employer_dashboard');
  const rangeInvalid = payRangeExceeds(payMin, payMax);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('modal.pay_min')}>
          <Input
            type="number"
            min={0}
            className="tabular-nums"
            value={payMin}
            onChange={(e) => onPayMinChange(e.target.value)}
            disabled={disabled}
            aria-invalid={rangeInvalid || undefined}
          />
        </Field>
        <Field label={t('modal.pay_max')}>
          <Input
            type="number"
            min={0}
            className="tabular-nums"
            value={payMax}
            onChange={(e) => onPayMaxChange(e.target.value)}
            disabled={disabled}
            aria-invalid={rangeInvalid || undefined}
          />
        </Field>
      </div>
      {rangeInvalid && (
        <p role="alert" className="-mt-2 text-xs font-semibold text-[var(--jale-danger)]">
          {t('modal.validation_pay_range')}
        </p>
      )}
      <Field label={t('modal.pay_interval')}>
        <Select
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}</label>
      {children}
    </div>
  );
}
