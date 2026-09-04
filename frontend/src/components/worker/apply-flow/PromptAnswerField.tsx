'use client';
import { useId } from 'react';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_PROMPT_ANSWER_CHARS,
  promptAnswerTooLong,
} from '@/lib/application-requirements-flow';

/**
 * One employer question and the box the worker answers it in.
 *
 * Modelled on `TrustQuestionStep`'s field: the QUESTION is the label and the
 * only thing above the box, with the character counter and the one live hint
 * sharing the line beneath it. Same tokens, same 13px muted hint, same
 * tabular counter -- these two are the only places in the worker app where
 * someone writes free text for an employer to read, and they should feel like
 * the same act.
 *
 * TWO DELIBERATE DEPARTURES FROM THAT FIELD, both from B4.0 #6:
 *
 *  - NO MINIMUM. `TrustQuestionStep` enforces a 15-character floor and says
 *    so ("a bit more please"). There is none here and no hint for one: "yes"
 *    is a complete answer to "Do you have your own truck?", and the prototype's
 *    `w2.more` line is copy for a rule that was dropped.
 *  - The cap is 1000, not the 300 the prototype's counter shows. That 300 is
 *    the EMPLOYER's soft guide for how long their own question should be; the
 *    worker's answer bound is the same 1000 both doors enforce.
 *
 * The blank hint is shown only once the worker has TOUCHED the field. An
 * answer nobody has opened yet is unwritten, not wrong, and lighting up every
 * box on arrival would read as a form full of errors.
 */
export function PromptAnswerField({
  question,
  value,
  touched,
  disabled,
  autoFocus = false,
  onChange,
  labels,
}: {
  question: string;
  value: string;
  touched: boolean;
  disabled: boolean;
  /**
   * The FIRST field on the screen sets this, so a worker who tapped Apply can
   * start writing without hunting for the box. Explicit rather than spread:
   * this component takes a named prop for everything it puts on the textarea.
   */
  autoFocus?: boolean;
  onChange: (text: string) => void;
  /** Resolved by the parent so this stays a pure, namespace-agnostic field. */
  labels: {
    placeholder: string;
    chars: string;
    tooLong: string;
    blankHint: string;
  };
}) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;

  const trimmed = value.trim();
  const tooLong = promptAnswerTooLong(value);
  const blank = touched && trimmed.length === 0;
  const hint = tooLong ? labels.tooLong : blank ? labels.blankHint : '';

  return (
    <div className="grid gap-2">
      <label
        htmlFor={fieldId}
        className="text-sm font-semibold leading-snug text-[var(--jale-ink)]"
      >
        {question}
      </label>
      <Textarea
        id={fieldId}
        className="min-h-[96px] font-normal"
        placeholder={labels.placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={tooLong || blank ? true : undefined}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex items-start justify-between gap-2">
        <span
          id={hintId}
          className={[
            'flex-1 text-[13px]',
            hint ? 'text-[var(--jale-danger)]' : 'text-[var(--jale-ink-2)]',
          ].join(' ')}
        >
          {hint}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-[var(--jale-ink-2)]">
          {labels.chars}
        </span>
      </div>
    </div>
  );
}

export { MAX_PROMPT_ANSWER_CHARS };
