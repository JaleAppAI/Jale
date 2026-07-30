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
  const [closing, setClosing] = useState(false);

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
    let firstLoad = true;

    async function load() {
      if (firstLoad) setLoading(true);
      try {
        const detail = await getConversation(idToken!, selectedId!);
        if (!active) return;
        setConversation(detail.conversation);
        setMessages(detail.messages);
      } catch (err) {
        handleDrawerLegalWall(err);
      } finally {
        if (active) setLoading(false);
        firstLoad = false;
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
    setClosing(true);
    try {
      const detail = await closeConversation(idToken, selectedId);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      setConversations((current) => current.filter((item) => item.id !== selectedId));
      setSelectedId(null);
    } finally {
      setClosing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-[var(--jale-blue-900)] px-4 py-3 text-sm font-bold text-white shadow-lg"
      >
        <span className="h-2 w-2 rounded-full bg-[#25D366]" />
        {open ? t('drawer_close') : t('drawer_button')}
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-30 flex h-[620px] max-h-[calc(100vh-7rem)] w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-white shadow-2xl">
          <aside className="hidden w-60 border-r border-[var(--jale-divider)] bg-[#fbfcff] sm:block">
            <div className="border-b border-[var(--jale-divider)] bg-[var(--jale-blue-900)] p-3 text-white">
              <p className="text-sm font-bold">{t('title')}</p>
              <p className="mt-0.5 text-[11px] text-white/45">WhatsApp</p>
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
                    'flex w-full gap-2 border-b border-[#f0f2f5] p-3 text-left text-sm transition-colors',
                    selectedId === item.id ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-white',
                  ].join(' ')}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-[10px] font-extrabold text-[var(--jale-blue-700)]">
                    {initialsFor(item.worker_name ?? t('unknown_worker'))}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-[var(--jale-ink)]">{item.worker_name ?? t('unknown_worker')}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.job_title}</span>
                    <span className="mt-1 block truncate text-[11px] text-muted">{item.last_message_preview ?? t('no_messages')}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[var(--jale-divider)] bg-[var(--jale-blue-900)] p-3 text-white sm:hidden">
              <p className="text-sm font-bold">{t('title')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t('hide')}
              </Button>
            </div>
            <ConversationThread
              key={conversation?.id ?? 'none'}
              conversation={conversation}
              messages={messages}
              loading={loading}
              sending={sending}
              closing={closing}
              onSend={handleSend}
              onClose={conversation?.status === 'open' ? handleClose : undefined}
              compact
            />
          </div>
        </div>
      )}
    </>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}
