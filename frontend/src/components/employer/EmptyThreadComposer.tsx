'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { initialsFor } from '@/components/employer/ConversationThread';
import type { InboxItem } from '@/lib/api/employer';

/**
 * The "no thread yet" pane: an applicant who has never been messaged.
 *
 * `onSend` follows the same contract as `ConversationThread`'s -- it MUST
 * reject when starting the conversation failed, and this component clears the
 * draft only after it resolves. It used to signal failure with a `Promise<
 * boolean>` instead, which meant a caller that forgot to return `false` would
 * silently eat the user's first message; a rejection cannot be forgotten.
 */

type Props = {
  item: InboxItem;
  sending?: boolean;
  /** Failure copy owned by the caller, rendered against the composer. */
  errorMessage?: string | null;
  /** Rejects on failure -- the draft survives. */
  onSend: (body: string) => Promise<void>;
  onDismiss?: () => void;
  /** Phone-only "back to the list" affordance. */
  onBack?: () => void;
};

export function EmptyThreadComposer({
  item,
  sending = false,
  errorMessage = null,
  onSend,
  onDismiss,
  onBack,
}: Props) {
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [body, setBody] = useState('');
  const errorId = useId();

  const workerName = item.worker_name ?? t('unknown_worker');
  const appliedDate = formatAppliedDate(item.applied_at, format);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    try {
      await onSend(trimmed);
      setBody('');
    } catch {
      // The caller reports this through `errorMessage`. Catching here is what
      // preserves the draft and keeps the rejection off the console.
    }
  }

  return (
    <section className="anim-fade-in flex min-h-[420px] flex-1 flex-col overflow-hidden bg-[var(--jale-card)]">
      <header className="shrink-0 border-b border-[var(--jale-divider)] px-4 py-3">
        {/* Wraps rather than squeezes -- see the note in ConversationThread. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={t('back_to_list')}
                className="-ml-1 shrink-0 cursor-pointer rounded p-1.5 leading-none text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] xl:hidden"
              >
                <svg
                  width={18}
                  height={18}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            ) : null}

            <span className="avatar-initials h-10 w-10 shrink-0 text-xs">{initialsFor(workerName)}</span>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2">
                <h2 className="truncate text-sm font-bold text-[var(--jale-ink)]">{workerName}</h2>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--jale-ink-2)]">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--jale-blue-700)]" />
                  {t('new_applicant')}
                </span>
              </div>
              <p className="truncate text-[11px] font-medium text-[var(--jale-ink-2)]">
                {appliedDate ? `${item.job_title} - ${t('applied_on', { date: appliedDate })}` : item.job_title}
              </p>
            </div>
          </div>

          {onDismiss ? (
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              {t('not_interested')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center bg-[var(--jale-paper-2)] p-4">
        <EmptyState icon="message" title={t('no_messages')} body={t('first_message_hint')} />
      </div>

      <form onSubmit={handleSubmit} className="shrink-0 border-t border-[var(--jale-divider)] p-3">
        {errorMessage ? (
          <p id={errorId} role="alert" className="mb-2 text-xs font-medium text-[var(--jale-danger-text)]">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex gap-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={t('composer_placeholder')}
            aria-describedby={errorMessage ? errorId : undefined}
            aria-invalid={errorMessage ? true : undefined}
            /* Ring, not just the border swap -- see the identical composer in
               `ConversationThread.tsx`. Border-only was 2.20:1 in dark. */
            className="min-h-[42px] flex-1 resize-none rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-3 py-2 text-sm text-[var(--jale-ink)] outline-none placeholder:text-[var(--jale-ink-2)] focus:border-[var(--primary)] focus:bg-[var(--jale-card)] focus:shadow-[var(--shadow-focus)]"
          />
          <Button type="submit" loading={sending} loadingLabel={tCommon('loading')} disabled={!body.trim()}>
            {t('send')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function formatAppliedDate(value: string, format: ReturnType<typeof useFormatter>): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return format.dateTime(date, { month: 'short', day: 'numeric' });
}
