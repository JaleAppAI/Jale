'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type {
  EmployerConversationDetail,
  EmployerConversationMessage,
} from '@/lib/api/employer';

type Props = {
  conversation: EmployerConversationDetail | null;
  messages: EmployerConversationMessage[];
  loading?: boolean;
  sending?: boolean;
  errorMessage?: string | null;
  onSend: (body: string) => Promise<void>;
  onClose?: () => Promise<void>;
  onDismiss?: () => void;
  compact?: boolean;
};

export function ConversationThread({
  conversation,
  messages,
  loading = false,
  sending = false,
  errorMessage = null,
  onSend,
  onClose,
  onDismiss,
  compact = false,
}: Props) {
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const [body, setBody] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending || !conversation || conversation.status === 'closed') return;
    await onSend(trimmed);
    setBody('');
  }

  if (loading) {
    return <p className="p-4 text-sm text-muted">{tCommon('loading')}</p>;
  }

  if (!conversation) {
    return (
      <section className="flex min-h-[420px] flex-1 items-center justify-center bg-white">
        <p className="rounded-md bg-[var(--jale-paper-2)] px-4 py-3 text-sm text-muted">
          {t('empty_select')}
        </p>
      </section>
    );
  }

  const workerName = conversation.worker_name ?? t('unknown_worker');
  const initials = initialsFor(workerName);
  const lastMessage = messages[messages.length - 1];

  return (
    <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden bg-white">
      <div className="border-b border-[var(--jale-divider)] bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-xs font-extrabold text-[var(--jale-blue-700)]">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-bold text-[var(--jale-ink)]">
                  {workerName}
                </h2>
                <span
                  className={[
                    'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase',
                    conversation.status === 'open'
                      ? 'bg-[var(--jale-success-bg)] text-[#1f7a44]'
                      : 'bg-[var(--jale-paper-2)] text-[var(--jale-ink-2)]',
                  ].join(' ')}
                >
                  {conversation.status === 'open' ? t('status_open') : t('status_closed')}
                </span>
              </div>
              <p className="truncate text-[11px] font-medium text-muted-foreground">
                WhatsApp - {conversation.job_title}
              </p>
              {!compact && lastMessage && (
                <p className="mt-0.5 text-[10px] text-muted">
                  {formatMessageTime(lastMessage.created_at)}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDismiss && (
              <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
                {t('not_interested')}
              </Button>
            )}
            {onClose && conversation.status === 'open' && (
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t('close')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto bg-[#f7f8fb] p-4">
        {messages.length === 0 ? (
          <div className="mx-auto mt-8 max-w-xs rounded-lg border border-dashed border-[var(--jale-divider)] bg-white px-4 py-6 text-center">
            <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('no_messages')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
        ) : (
          messages.map((message) => {
            const mine = message.sender_type === 'employer';
            return (
              <div key={message.id} className={`flex gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
                {!mine && (
                  <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-[10px] font-extrabold text-[var(--jale-blue-700)]">
                    {initials}
                  </div>
                )}
                <div className={`max-w-[82%] ${mine ? 'text-right' : 'text-left'}`}>
                  <div
                    className={[
                      'inline-block px-3 py-2 text-sm leading-relaxed shadow-sm',
                      mine
                        ? 'rounded-[8px_0_8px_8px] bg-[var(--jale-blue-500)] text-white'
                        : 'rounded-[0_8px_8px_8px] bg-white text-[var(--jale-ink)]',
                    ].join(' ')}
                  >
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  </div>
                  <p className={`mt-1 text-[10px] ${mine ? 'text-muted-foreground' : 'text-muted'}`}>
                    {mine ? t(`message_status.${message.status}`) : t('from_worker')}
                    {' - '}
                    {formatMessageTime(message.created_at)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--jale-divider)] bg-white p-3">
        {errorMessage && (
          <p id="conversation-thread-error" role="alert" className="mb-2 text-xs text-error">
            {errorMessage}
          </p>
        )}
        {conversation.status === 'closed' ? (
          <p className="text-sm text-muted">{t('closed_hint')}</p>
        ) : (
          <div className="flex gap-2">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={2000}
              rows={compact ? 1 : 2}
              placeholder={t('composer_placeholder')}
              aria-describedby={errorMessage ? 'conversation-thread-error' : undefined}
              className="min-h-[42px] flex-1 resize-none rounded-md border-0 bg-[var(--jale-paper-2)] px-3 py-2 text-sm text-[var(--jale-ink)] outline-none focus:bg-white focus:ring-1 focus:ring-[var(--jale-blue-500)]"
            />
            <Button type="submit" loading={sending} loadingLabel={tCommon('loading')} disabled={!body.trim()}>
              {t('send')}
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
