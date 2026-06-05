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
  onSend: (body: string) => Promise<void>;
  onClose?: () => Promise<void>;
};

export function ConversationThread({
  conversation,
  messages,
  loading = false,
  sending = false,
  onSend,
  onClose,
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
    return <p className="p-4 text-sm text-muted">{t('empty_select')}</p>;
  }

  return (
    <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--jale-divider)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-muted">{conversation.job_title}</p>
            <h2 className="truncate text-base font-semibold">
              {conversation.worker_name ?? t('unknown_worker')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {conversation.status === 'open' ? t('status_open') : t('status_closed')}
            </p>
          </div>
          {onClose && conversation.status === 'open' && (
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t('close')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">{t('no_messages')}</p>
        ) : (
          messages.map((message) => {
            const mine = message.sender_type === 'employer';
            return (
              <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={[
                    'max-w-[82%] rounded-2xl px-4 py-2 text-sm shadow-sm',
                    mine
                      ? 'bg-[var(--jale-blue-900)] text-white'
                      : 'bg-[var(--jale-paper-2)] text-[var(--jale-ink)]',
                  ].join(' ')}
                >
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <p className={`mt-1 text-[11px] ${mine ? 'text-white/70' : 'text-muted-foreground'}`}>
                    {mine ? t(`message_status.${message.status}`) : t('from_worker')}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[var(--jale-divider)] p-4">
        {conversation.status === 'closed' ? (
          <p className="text-sm text-muted">{t('closed_hint')}</p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={2000}
              rows={2}
              placeholder={t('composer_placeholder')}
              className="min-h-[52px] flex-1 resize-none rounded-xl border border-[var(--jale-divider)] px-3 py-2 text-sm outline-none focus:border-[var(--jale-blue-500)]"
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
