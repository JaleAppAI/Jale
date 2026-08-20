'use client';
import type React from 'react';
import { useTranslations } from 'next-intl';
import { TRADE_CATEGORIES, type JobForm } from '@/lib/job-form';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * Trade select + the "Other" reveal (job-flow redesign, FE-T6). Shared by
 * PostJobModal's step 1 and JobFormFields (EditJobModal + TemplateEditModal)
 * so the reveal rule -- and its copy -- can't drift between the two.
 *
 * Mirrors the existing reveal idiom from the worker signup form
 * (`WorkerAuthForm`'s `mainTrade === 'other'` -> `mainTradeOther` input):
 * the free-text field only renders while `other` is selected, but switching
 * away does NOT clear whatever was typed -- it just stops rendering (and
 * stops mattering: `job-form.ts`'s `jobFormToBasePayload` already gates
 * `trade_category_other` on `trade_category === 'other'`, and
 * `validateStepBasics` only requires it in that state). Re-selecting `other`
 * later brings the same text back, same as the worker form.
 */
interface TradeCategoryFieldProps {
  tradeCategory: JobForm['trade_category'];
  tradeCategoryOther: string;
  onTradeCategoryChange: (value: JobForm['trade_category']) => void;
  onTradeCategoryOtherChange: (value: string) => void;
  disabled?: boolean;
}

export function TradeCategoryField({
  tradeCategory, tradeCategoryOther, onTradeCategoryChange, onTradeCategoryOtherChange, disabled,
}: TradeCategoryFieldProps) {
  const t = useTranslations('employer_dashboard');

  return (
    <div className="grid gap-4">
      <Field label={t('modal.trade_category')} required>
        <Select
          value={tradeCategory}
          onChange={(e) => onTradeCategoryChange(e.target.value as JobForm['trade_category'])}
          disabled={disabled}
        >
          <option value="">{t('modal.select_placeholder')}</option>
          {TRADE_CATEGORIES.map((trade) => (
            <option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>
          ))}
        </Select>
      </Field>

      {tradeCategory === 'other' && (
        <Field label={t('modal.trade_other_label')} required>
          <Input
            value={tradeCategoryOther}
            onChange={(e) => onTradeCategoryOtherChange(e.target.value)}
            placeholder={t('modal.trade_other_placeholder')}
            disabled={disabled}
          />
          <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{t('modal.trade_other_hint')}</p>
        </Field>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
