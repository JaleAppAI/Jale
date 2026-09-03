'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { PromptAnswerField } from '@/components/worker/apply-flow/PromptAnswerField';
import {
  MAX_PROMPT_ANSWER_CHARS,
  missingPromptAnswers,
} from '@/lib/application-requirements-flow';
import type { PreApplicationPrompt } from '@/lib/api/worker';

/**
 * The prompt TOP-UP: the employer's apply-time questions, finished here.
 *
 * WHO SEES THIS. A worker who applied over WhatsApp and walked away part-way
 * through the questions (`cancelar`, or simply stopped replying) keeps their
 * application with a partial set of answers. Those answers are write-once and
 * are NOT stage-gated on the backend, so this is the one surface that can
 * finish them -- which is why an outstanding prompt beats the `not_requested`
 * terminal panel in `terminalScreen`.
 *
 * IT IS A GATE, NOT A STEP. `REQUIREMENT_STEP_IDS` stays three: prompts belong
 * to stage ONE, and putting them in the stepper would tell a worker that
 * answering the employer's questions is part of "completing your details",
 * which it is not. It renders ahead of the stepper and hands over once done.
 *
 * ONLY THE UNANSWERED ONES are shown. The merge is `new || existing`, so an id
 * that already has an answer would silently ignore whatever was typed over it
 * -- offering an editable box for a value that cannot change is a lie.
 */
export function PromptTopUpStep({
  prompts, companyName, saving, error, onSubmit,
}: {
  /** Only the outstanding ones -- the caller filters on `remaining.prompts`. */
  prompts: readonly PreApplicationPrompt[];
  companyName?: string | null;
  saving: boolean;
  error: string | null;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const t = useTranslations('worker_application_details.prompts');
  const tApply = useTranslations('worker_job_detail.apply_flow');
  const tCommon = useTranslations('common');

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());

  const canSubmit = missingPromptAnswers(prompts, answers).length === 0;

  function set(promptId: string, text: string) {
    setAnswers((prev) => ({ ...prev, [promptId]: text }));
    setTouched((prev) => new Set(prev).add(promptId));
  }

  return (
    <div className="anim-fade-in grid gap-5">
      <div>
        <h2 className="text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
          {t('title')}
        </h2>
        <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">
          {t('intro', { company: companyName ?? '' }).replace(/\s{2,}/g, ' ').trim()}
        </p>
      </div>

      {prompts.map((prompt) => {
        const value = answers[prompt.id] ?? '';
        return (
          <PromptAnswerField
            key={prompt.id}
            question={prompt.text}
            value={value}
            touched={touched.has(prompt.id)}
            disabled={saving}
            onChange={(text) => set(prompt.id, text)}
            labels={{
              placeholder: tApply('placeholder'),
              chars: tApply('chars', { count: value.trim().length, max: MAX_PROMPT_ANSWER_CHARS }),
              tooLong: tApply('too_long', { max: MAX_PROMPT_ANSWER_CHARS }),
              blankHint: tApply('blank_hint'),
            }}
          />
        );
      })}

      {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}

      <Button
        className="w-full"
        size="lg"
        disabled={!canSubmit}
        loading={saving}
        loadingLabel={tCommon('loading')}
        onClick={() => onSubmit(
          Object.fromEntries(prompts.map((p) => [p.id, (answers[p.id] ?? '').trim()])),
        )}
      >
        {t('submit')}
      </Button>
    </div>
  );
}
