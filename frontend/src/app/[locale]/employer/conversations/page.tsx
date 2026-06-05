'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Card } from '@/components/ui/card';
import { ConversationThread } from '@/components/employer/ConversationThread';
import {
  closeConversation,
  getConversation,
  getConversations,
  sendConversationMessage,
} from '@/lib/api/employer';
import type {
  EmployerConversationDetail,
  EmployerConversationMessage,
  EmployerConversationSummary,
} from '@/lib/api/employer';

export const dynamic = 'force-dynamic';

export default function EmployerConversationsPage() {
  const searchParams = useSearchParams();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');

  const [conversations, setConversations] = useState<EmployerConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('conversation_id'));
  const [conversation, setConversation] = useState<EmployerConversationDetail | null>(null);
  const [messages, setMessages] = useState<EmployerConversationMessage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!idToken) return;
    let active = true;
    setLoadingList(true);

    getConversations(idToken)
      .then((res) => {
        if (!active) return;
        setConversations(res.conversations);
        setSelectedId((current) => current ?? res.conversations[0]?.id ?? null);
      })
      .catch((err) => {
        try {
          handleLegalWall(err, '/employer/conversations');
        } catch {
          setError(tCommon('error'));
        }
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    return () => { active = false; };
  }, [idToken]);

  useEffect(() => {
    if (!idToken || !selectedId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    let active = true;

    async function loadThread() {
      setLoadingThread(true);
      try {
        const detail = await getConversation(idToken!, selectedId!);
        if (!active) return;
        setConversation(detail.conversation);
        setMessages(detail.messages);
      } catch (err) {
        try {
          handleLegalWall(err, '/employer/conversations');
        } catch {
          setError(tCommon('error'));
        }
      } finally {
        if (active) setLoadingThread(false);
      }
    }

    loadThread();
    const interval = window.setInterval(loadThread, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [idToken, selectedId]);

  async function handleSend(body: string) {
    if (!idToken || !selectedId) return;
    setSending(true);
    try {
      const detail = await sendConversationMessage(idToken, selectedId, body);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      setConversations((current) => current.map((item) => (
        item.id === detail.conversation.id ? detail.conversation : item
      )));
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedId) return;
    const detail = await closeConversation(idToken, selectedId);
    setConversation(detail.conversation);
    setMessages(detail.messages);
    setConversations((current) => current.map((item) => (
      item.id === detail.conversation.id ? detail.conversation : item
    )));
  }

  if (error) {
    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-sm text-error">{error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <Card className="grid min-h-[640px] overflow-hidden lg:grid-cols-[320px_1fr]">
        <aside className="border-b border-[var(--jale-divider)] lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--jale-divider)] p-4">
            <p className="text-sm font-semibold">{t('threads')}</p>
          </div>
          {loadingList ? (
            <p className="p-4 text-sm text-muted">{tCommon('loading')}</p>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t('empty')}</p>
          ) : (
            <div className="max-h-[280px] overflow-y-auto lg:max-h-[600px]">
              {conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={[
                    'block w-full border-b border-[var(--jale-divider)] p-4 text-left',
                    selectedId === item.id ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[var(--jale-paper-2)]',
                  ].join(' ')}
                >
                  <span className="block truncate text-sm font-semibold">{item.worker_name ?? t('unknown_worker')}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">{item.job_title}</span>
                  {item.last_message_preview && (
                    <span className="mt-2 block truncate text-xs text-muted">{item.last_message_preview}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </aside>
        <ConversationThread
          conversation={conversation}
          messages={messages}
          loading={loadingThread}
          sending={sending}
          onSend={handleSend}
          onClose={conversation?.status === 'open' ? handleClose : undefined}
        />
      </Card>
    </main>
  );
}
