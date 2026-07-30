'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { InboxItem } from '@/lib/api/employer';

type Props = {
  item: InboxItem;
  sending?: boolean;
  errorMessage?: string | null;
  onSend: (body: string) => Promise<boolean>;
  onDismiss?: () => void;
};

export function EmptyThreadComposer({ item, sending = false, errorMessage = null, onSend, onDismiss }: Props) {
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const [body, setBody] = useState('');

  const workerName = item.worker_name ?? t('unknown_worker');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    const ok = await onSend(trimmed);
    if (ok) setBody('');
  }

  return (
    <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden bg-white">
      <div className="border-b border-[var(--jale-divider)] bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-xs font-extrabold text-[var(--jale-blue-700)]">
              {initialsFor(workerName)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-bold text-[var(--jale-ink)]">{workerName}</h2>
                <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--jale-blue-50)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--jale-blue-700)]">
                  {t('new_applicant')}
                </span>
              </div>
              <p className="truncate text-[11px] font-medium text-muted-foreground">
                {(() => {
                  const appliedDate = formatAppliedDate(item.applied_at, format);
                  return appliedDate
                    ? `${item.job_title} - ${t('applied_on', { date: appliedDate })}`
                    : item.job_title;
                })()}
              </p>
            </div>
          </div>
          {onDismiss && (
            <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
              {t('not_interested')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center bg-[#f7f8fb] p-4">
        <div className="mx-auto max-w-xs rounded-lg border border-dashed border-[var(--jale-divider)] bg-white px-4 py-6 text-center">
          <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('no_messages')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('first_message_hint')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--jale-divider)] bg-white p-3">
        {errorMessage && (
          <p id="empty-thread-composer-error" role="alert" className="mb-2 text-xs text-error">
            {errorMessage}
          </p>
        )}
        <div className="flex gap-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={2000}
            rows={2}
            placeholder={t('composer_placeholder')}
            aria-describedby={errorMessage ? 'empty-thread-composer-error' : undefined}
            className="min-h-[42px] flex-1 resize-none rounded-md border-0 bg-[var(--jale-paper-2)] px-3 py-2 text-sm text-[var(--jale-ink)] outline-none focus:bg-white focus:ring-1 focus:ring-[var(--jale-blue-500)]"
          />
          <Button type="submit" loading={sending} loadingLabel={tCommon('loading')} disabled={!body.trim()}>
            {t('send')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function formatAppliedDate(value: string, format: ReturnType<typeof useFormatter>): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return format.dateTime(date, { month: 'short', day: 'numeric' });
}
