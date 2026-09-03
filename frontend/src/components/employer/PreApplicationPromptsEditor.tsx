'use client';
import { useTranslations } from 'next-intl';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Textarea } from '@/components/ui/textarea';
import {
    MAX_PROMPT_CHARS,
    SOFT_PROMPT_CHARS,
    addPrompt,
    canAddPrompt,
    movePrompt,
    promptTipLevel,
    removePromptAt,
    updatePromptText,
    type PromptDraft,
} from '@/lib/pre-application-prompts';

/**
 * "Pre-application questions" -- the employer's apply-time questions
 * (`jobs.pre_application_prompts`, migration 091).
 *
 * Sits ABOVE `RequirementsPicker` on step 3 of PostJobModal and in
 * JobFormFields (Edit/Template), because it is the only thing on that panel a
 * worker meets while applying: everything the picker below configures is now
 * asked later, once the employer requests details. The section's own subtitle
 * and the picker's new `after_request_note` are what carry that split.
 *
 * Presentational and fully controlled -- every mutation goes through
 * `lib/pre-application-prompts.ts` and comes back as a whole new list on
 * `onChange`. In particular this component never mints an id itself: `addPrompt`
 * is the ONE mint site, and every other operation preserves the ids it was
 * handed. See that module's header for why a re-minted id breaks a locked job.
 *
 * `locked` (the job already has applicants -- the same freeze `JobFormFields`
 * applies to job_type and the picker) disables every control and shows the
 * picker's existing locked note rather than inventing a second vocabulary for
 * the same state.
 */
export function PreApplicationPromptsEditor({
    prompts,
    onChange,
    locked = false,
}: {
    prompts: PromptDraft[];
    onChange: (next: PromptDraft[]) => void;
    locked?: boolean;
}) {
    const t = useTranslations('job_requirements');

    const emit = (next: PromptDraft[]) => {
        if (locked) return;
        onChange(next);
    };

    const tipLevel = promptTipLevel(prompts.length);

    return (
        <div className="grid gap-3">
            <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                    {t('prompts.section_title')}
                </p>
                <p className="mt-1 text-xs text-[var(--jale-ink-2)]">{t('prompts.section_subtitle')}</p>
            </div>

            {locked && (
                <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('picker.locked_note')}</p>
            )}

            {prompts.length === 0 ? (
                <p className="text-xs text-[var(--jale-ink-2)]">{t('prompts.empty')}</p>
            ) : (
                <ul className="grid gap-2">
                    {prompts.map((prompt, index) => (
                        <li
                            key={prompt.id}
                            className="grid gap-2 rounded-[var(--radius-card)] border border-[var(--jale-divider)] p-3"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span
                                    id={`prompt-label-${prompt.id}`}
                                    className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]"
                                >
                                    {t('prompts.question_number', { number: index + 1 })}
                                </span>
                                <span className="flex flex-wrap gap-1">
                                    <RowButton
                                        label={t('prompts.move_up')}
                                        ariaLabel={t('prompts.move_up_aria', { number: index + 1 })}
                                        disabled={locked || index === 0}
                                        onClick={() => emit(movePrompt(prompts, index, -1))}
                                    />
                                    <RowButton
                                        label={t('prompts.move_down')}
                                        ariaLabel={t('prompts.move_down_aria', { number: index + 1 })}
                                        disabled={locked || index === prompts.length - 1}
                                        onClick={() => emit(movePrompt(prompts, index, 1))}
                                    />
                                    <RowButton
                                        label={t('prompts.remove')}
                                        ariaLabel={t('prompts.remove_aria', { number: index + 1 })}
                                        disabled={locked}
                                        onClick={() => emit(removePromptAt(prompts, index))}
                                    />
                                </span>
                            </div>

                            <Textarea
                                aria-labelledby={`prompt-label-${prompt.id}`}
                                rows={2}
                                value={prompt.text}
                                disabled={locked}
                                placeholder={t('prompts.placeholder')}
                                /*
                                 * The HARD backend bound (migration 091's CHECK),
                                 * not the counter's 300: capping the input at the
                                 * soft guide would silently turn guidance into a
                                 * gate. `validateStepRequirements` still refuses
                                 * `prompt_too_long` as the real defence -- this
                                 * only stops a paste that could never save.
                                 */
                                maxLength={MAX_PROMPT_CHARS}
                                onChange={(event) => emit(updatePromptText(prompts, index, event.target.value))}
                            />

                            {!locked && (
                                <p className="text-right text-[11px] tabular-nums text-[var(--jale-ink-2)]">
                                    {t('prompts.counter', {
                                        count: prompt.text.trim().length,
                                        max: SOFT_PROMPT_CHARS,
                                    })}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {/* Hidden, not disabled, at the cap: there is nothing to explain --
                ten questions is far past the point the tip below is warning
                about, and a permanently dead button reads as a bug. */}
            {canAddPrompt(prompts) && (
                <div>
                    <button
                        type="button"
                        disabled={locked}
                        onClick={() => emit(addPrompt(prompts))}
                        className={[
                            'inline-flex h-9 items-center justify-center gap-1 rounded-full',
                            'border border-[var(--jale-divider)] bg-transparent px-4',
                            'text-xs font-semibold leading-none text-[var(--jale-ink)]',
                            'transition-colors duration-150 hover:bg-[var(--jale-paper-2)]',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            'disabled:cursor-not-allowed disabled:opacity-60',
                        ].join(' ')}
                    >
                        <span aria-hidden>+</span>
                        {t('prompts.add')}
                    </button>
                </div>
            )}

            {/*
              ALWAYS visible, never dismissible: it is the one place an employer
              is told what asking more costs them, and it has to be readable
              BEFORE they add the third question, not after. Above the
              recommendation the same advice speaks in the warning tone and
              names the count they actually have.
            */}
            <InlineFeedback tone={tipLevel === 'warning' ? 'warning' : 'info'}>
                {tipLevel === 'warning'
                    ? t('prompts.tip_warning', { count: prompts.length })
                    : t('prompts.tip')}
            </InlineFeedback>
        </div>
    );
}

function RowButton({
    label, ariaLabel, disabled, onClick,
}: {
    label: string;
    ariaLabel: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={onClick}
            className={[
                'rounded-full px-2.5 py-1 text-[11px] font-bold',
                'text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)]',
                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
            ].join(' ')}
        >
            {label}
        </button>
    );
}
