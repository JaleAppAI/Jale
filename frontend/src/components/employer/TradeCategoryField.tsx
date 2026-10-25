'use client';
import type React from 'react';
import { useId } from 'react';
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
  /**
   * The field a refused step is about, with the sentence shown under it. The
   * control is marked `aria-invalid` and described by that sentence. Both
   * controls carry `data-field`, so the wizard can move focus to them.
   */
  fieldError?: { field: 'trade_category' | 'trade_category_other'; message: string } | null;
  /** Step-by-step guide hooks (`data-guide`) on the trade field and on the Other box, label included. */
  tradeGuide?: string;
  otherGuide?: string;
}

export function TradeCategoryField({
  tradeCategory, tradeCategoryOther, onTradeCategoryChange, onTradeCategoryOtherChange, disabled,
  fieldError, tradeGuide, otherGuide,
}: TradeCategoryFieldProps) {
  const t = useTranslations('employer_dashboard');
  const selectId = useId();
  const otherId = useId();
  const errorId = useId();
  const tradeInvalid = fieldError?.field === 'trade_category';
  const otherInvalid = fieldError?.field === 'trade_category_other';

  return (
    <div className="grid gap-4">
      <Field label={t('modal.trade_category')} htmlFor={selectId} required guide={tradeGuide}>
        <Select
          id={selectId}
          data-field="trade_category"
          aria-invalid={tradeInvalid || undefined}
          aria-describedby={tradeInvalid ? errorId : undefined}
          value={tradeCategory}
          onChange={(e) => onTradeCategoryChange(e.target.value as JobForm['trade_category'])}
          disabled={disabled}
        >
          <option value="">{t('modal.select_placeholder')}</option>
          {TRADE_CATEGORIES.map((trade) => (
            <option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>
          ))}
        </Select>
        {tradeInvalid && <FieldMessage id={errorId}>{fieldError.message}</FieldMessage>}
      </Field>

      {tradeCategory === 'other' && (
        <Field label={t('modal.trade_other_label')} htmlFor={otherId} required guide={otherGuide}>
          <Input
            id={otherId}
            data-field="trade_category_other"
            aria-invalid={otherInvalid || undefined}
            aria-describedby={otherInvalid ? errorId : undefined}
            value={tradeCategoryOther}
            onChange={(e) => onTradeCategoryOtherChange(e.target.value)}
            placeholder={t('modal.trade_other_placeholder')}
            disabled={disabled}
          />
          {otherInvalid && <FieldMessage id={errorId}>{fieldError.message}</FieldMessage>}
          <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{t('modal.trade_other_hint')}</p>
        </Field>
      )}
    </div>
  );
}

function FieldMessage({ id, children }: { id: string; children: React.ReactNode }) {
  return <p id={id} className="text-xs font-medium text-[var(--jale-danger-text)]">{children}</p>;
}

function Field({ label, htmlFor, required, guide, children }: { label: string; htmlFor: string; required?: boolean; guide?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" data-guide={guide}>
      <label htmlFor={htmlFor} className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
