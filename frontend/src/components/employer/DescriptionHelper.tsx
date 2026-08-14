'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, generateJobDescription } from '@/lib/api/employer';
import { buildGenerateDescriptionPayload, type DescriptionHelperFields } from '@/lib/generate-description-payload';
import { getTradeSample, hasTradeSample } from '@/lib/trade-samples';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

interface DescriptionHelperProps {
  form: DescriptionHelperFields;
  onDescriptionChange: (value: string) => void;
  /** Freezes both actions (e.g. the host form is submitting elsewhere). */
  disabled?: boolean;
  /**
   * Reports the in-flight Generate call so the HOST can freeze its own
   * description Textarea while a response is pending. Without this, a manual
   * edit or a "Use a sample" click made mid-flight would be silently
   * overwritten seconds later by the eventual success response -- this
   * component disables its own "Use a sample" trigger for the same reason,
   * but it does not own the Textarea, so the host needs to hear about it too.
   */
  onGeneratingChange?: (generating: boolean) => void;
}

/**
 * The "Use a sample" / "Generate with AI" description affordances, shared by
 * every job-creation surface (`JobFormFields` -- edit + templates -- and
 * `PostJobModal`'s create wizard) so the three cannot drift on copy, disabled
 * logic or error handling. Deliberately host-agnostic: it takes the handful
 * of form fields it reads and a plain `onDescriptionChange` callback, and
 * does NOT render or own the description Textarea itself -- each host mounts
 * this directly beneath its own.
 */
export function DescriptionHelper({ form, onDescriptionChange, disabled = false, onGeneratingChange }: DescriptionHelperProps) {
  const t = useTranslations('employer_dashboard');
  const locale = useLocale();
  const { idToken } = useAuth();

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<'limit' | 'generic' | null>(null);

  // `other` and unset both read as "no trade picked" for both actions --
  // `other` has no O*NET sample to ground against, and the backend rejects
  // it outright for generation (400 `unsupported_trade_category`), so there
  // is no point round-tripping into the generic failure message for it.
  const canUseSample = hasTradeSample(form.trade_category);
  const canGenerate = !disabled && form.trade_category !== '' && form.trade_category !== 'other';

  const setGeneratingState = (value: boolean) => {
    setGenerating(value);
    onGeneratingChange?.(value);
  };

  const insertSample = () => {
    const sample = getTradeSample(form.trade_category, locale);
    if (!sample) return;
    onDescriptionChange(sample);
    // A prior Generate failure is no longer relevant to what's now in the
    // field -- the sample just replaced it.
    setGenerateError(null);
  };

  const handleGenerate = async () => {
    if (!canGenerate || !idToken || generating) return;
    setGeneratingState(true);
    setGenerateError(null);
    try {
      const payload = buildGenerateDescriptionPayload(form);
      const result = await generateJobDescription(idToken, payload);
      // Only touch the description on SUCCESS -- a failure below must never
      // clobber whatever the employer already typed.
      onDescriptionChange(locale === 'es' ? result.description_es : result.description_en);
    } catch (err) {
      setGenerateError(err instanceof ApiError && err.code === 'generation_limit_reached' ? 'limit' : 'generic');
    } finally {
      setGeneratingState(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {canUseSample && (
          <button
            type="button"
            onClick={insertSample}
            disabled={disabled || generating}
            className="text-xs font-bold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
          >
            {t('modal.description_helper.use_sample')}
          </button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleGenerate}
          disabled={!canGenerate}
          loading={generating}
          loadingLabel={t('modal.description_helper.generating')}
        >
          <Icon name="spark" />
          {t('modal.description_helper.generate')}
        </Button>
      </div>
      {canUseSample && (
        <p className="text-xs text-[var(--jale-ink-2)]">{t('modal.description_helper.source_credit')}</p>
      )}
      {canUseSample && form.description.trim() ? (
        <p className="text-xs text-[var(--jale-ink-2)]">{t('modal.description_helper.replace_hint')}</p>
      ) : null}
      {generateError && (
        <p className="text-xs font-semibold text-[var(--jale-danger)]">
          {generateError === 'limit'
            ? t('modal.description_helper.limit_reached')
            : t('modal.description_helper.generate_error')}
        </p>
      )}
    </>
  );
}
