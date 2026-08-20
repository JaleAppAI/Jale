'use client';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, generateJobDescription } from '@/lib/api/employer';
import {
  buildGenerateDescriptionPayload,
  capEmployerNotes,
  shouldSendAsNotes,
  type DescriptionHelperFields,
} from '@/lib/generate-description-payload';
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

  /**
   * Tracks the text most recently written into the description box by THIS
   * component -- either a successful AI generation or an inserted sample --
   * so `shouldSendAsNotes` can tell "the employer typed something new" apart
   * from "this is just what we put there." An inserted sample is tracked the
   * same way a generation is: it's canned O*NET-derived prose, not employer
   * input, and feeding it back as `employer_notes` on the next Generate would
   * be the same self-referential-drift problem a stale generation would be.
   */
  const lastGeneratedRef = useRef<string | null>(null);

  // `other` has no O*NET sample to ground a "Use a sample" insert against,
  // regardless of whether custom trade text is present.
  const canUseSample = hasTradeSample(form.trade_category);
  // Unset trade_category always disables Generate. `other` is now allowed,
  // but ONLY once the employer has typed a custom trade name -- the backend
  // rejects 'other' without `trade_category_other` outright (400
  // `unsupported_trade_category`, see employer-generate-description.ts), so
  // there is no point enabling the button (and round-tripping into the
  // generic failure message) until there's text to send.
  const canGenerate = !disabled && form.trade_category !== ''
    && (form.trade_category !== 'other' || form.trade_category_other.trim() !== '');

  const setGeneratingState = (value: boolean) => {
    setGenerating(value);
    onGeneratingChange?.(value);
  };

  const insertSample = () => {
    const sample = getTradeSample(form.trade_category, locale);
    if (!sample) return;
    onDescriptionChange(sample);
    // The sample is canned O*NET-derived prose, not employer input -- it
    // must not be fed back as `employer_notes` on the next Generate (see the
    // ref's doc comment above). Recording it here makes the next
    // `shouldSendAsNotes` read the untouched sample as "nothing new typed."
    lastGeneratedRef.current = sample;
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
      // Seed the request with whatever the employer has typed into the
      // description box, UNLESS it's just what we put there ourselves (a
      // prior generation or sample) -- see `shouldSendAsNotes`'s doc comment.
      if (shouldSendAsNotes(form.description, lastGeneratedRef.current)) {
        payload.employer_notes = capEmployerNotes(form.description);
      }
      const result = await generateJobDescription(idToken, payload);
      const generated = locale === 'es' ? result.description_es : result.description_en;
      // Recorded before the description actually updates in the host (that
      // update is async state in JobFormFields/PostJobModal) -- an immediate
      // re-generate must compare against this fresh value, not a stale one
      // left over from a render that hasn't happened yet.
      lastGeneratedRef.current = generated;
      // Only touch the description on SUCCESS -- a failure below must never
      // clobber whatever the employer already typed.
      onDescriptionChange(generated);
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
