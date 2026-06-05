'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from '@/i18n/navigation';
import { LegalWallError } from '@/lib/api';
import { Button } from '@/components/ui/button';
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

export function ConversationDrawer() {
  const { idToken, isAuthenticated, userType } = useAuth();
  const router = useRouter();
  const t = useTranslations('employer_messages');
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<EmployerConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<EmployerConversationDetail | null>(null);
  const [messages, setMessages] = useState<EmployerConversationMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  function handleDrawerLegalWall(err: unknown) {
    if (err instanceof LegalWallError) {
      sessionStorage.setItem('legalReturnUrl', '/employer/conversations');
      router.replace('/legal/accept');
    }
  }

  useEffect(() => {
    if (!open || !idToken || userType !== 'employer') return;
    let active = true;
    getConversations(idToken)
      .then((res) => {
        if (!active) return;
        const openConversations = res.conversations.filter((item) => item.status === 'open');
        setConversations(openConversations);
        setSelectedId((current) => current ?? openConversations[0]?.id ?? null);
      })
      .catch((err) => {
        handleDrawerLegalWall(err);
      });
    return () => { active = false; };
  }, [open, idToken, userType]);

  useEffect(() => {
    if (!open || !idToken || !selectedId) return;
    let active = true;

    async function load() {
      setLoading(true);
      try {
        const detail = await getConversation(idToken!, selectedId!);
        if (!active) return;
        setConversation(detail.conversation);
        setMessages(detail.messages);
      } catch (err) {
        handleDrawerLegalWall(err);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    const interval = window.setInterval(load, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [open, idToken, selectedId, router]);

  if (!isAuthenticated || userType !== 'employer') return null;

  async function handleSend(body: string) {
    if (!idToken || !selectedId) return;
    setSending(true);
    try {
      const detail = await sendConversationMessage(idToken, selectedId, body);
      setConversation(detail.conversation);
      setMessages(detail.messages);
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedId) return;
    const detail = await closeConversation(idToken, selectedId);
    setConversation(detail.conversation);
    setMessages(detail.messages);
    setConversations((current) => current.filter((item) => item.id !== selectedId));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-5 right-5 z-30 rounded-full bg-[var(--jale-blue-900)] px-4 py-3 text-sm font-semibold text-white shadow-lg"
      >
        {t('drawer_button')}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-30 flex h-[620px] max-h-[calc(100vh-7rem)] w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--jale-divider)] bg-white shadow-2xl">
          <aside className="hidden w-56 border-r border-[var(--jale-divider)] sm:block">
            <div className="border-b border-[var(--jale-divider)] p-3">
              <p className="text-sm font-semibold">{t('title')}</p>
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="p-3 text-xs text-muted">{t('empty')}</p>
              ) : conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={[
                    'block w-full border-b border-[var(--jale-divider)] p-3 text-left text-sm',
                    selectedId === item.id ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[var(--jale-paper-2)]',
                  ].join(' ')}
                >
                  <span className="block truncate font-semibold">{item.worker_name ?? t('unknown_worker')}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.job_title}</span>
                </button>
              ))}
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[var(--jale-divider)] p-3 sm:hidden">
              <p className="text-sm font-semibold">{t('title')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t('hide')}
              </Button>
            </div>
            <ConversationThread
              conversation={conversation}
              messages={messages}
              loading={loading}
              sending={sending}
              onSend={handleSend}
              onClose={conversation?.status === 'open' ? handleClose : undefined}
            />
          </div>
        </div>
      )}
    </>
  );
}
