'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
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
    let firstLoad = true;

    async function loadThread() {
      if (firstLoad) setLoadingThread(true);
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
        firstLoad = false;
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

  const openCount = conversations.filter((item) => item.status === 'open').length;
  const closedCount = conversations.filter((item) => item.status === 'closed').length;
  const waitingCount = conversations.filter((item) => !item.last_worker_message_at && item.status === 'open').length;
  const activeCount = conversations.filter((item) => item.last_worker_message_at && item.status === 'open').length;
  const selectedSummary = conversations.find((item) => item.id === selectedId) ?? conversation;

  if (error) {
    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-sm text-error">{error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <section className="mb-5 overflow-hidden rounded-xl bg-[var(--jale-blue-900)] px-5 py-5 text-white">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-white/45">WhatsApp</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-normal">
              {t('title')}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-white/55">{t('subtitle')}</p>
          </div>
          <div className="grid grid-cols-3 gap-5 text-center">
            <MetricValue value={openCount} label={t('status_open')} />
            <MetricValue value={waitingCount} label={t('waiting')} />
            <MetricValue value={activeCount} label={t('active')} />
          </div>
        </div>
      </section>

      <section className="mb-5 grid gap-3 md:grid-cols-4">
        <MetricCard tone="blue" value={conversations.length} label={t('threads')} detail={t('subtitle')} />
        <MetricCard tone="green" value={activeCount} label={t('worker_replied')} detail={t('reply_window_open')} />
        <MetricCard tone="amber" value={waitingCount} label={t('waiting_reply')} detail={t('template_invite_sent')} />
        <MetricCard tone="navy" value={closedCount} label={t('status_closed')} detail={t('archived_conversations')} />
      </section>

      <section className="grid min-h-[680px] overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-white shadow-sm xl:grid-cols-[320px_minmax(0,1fr)_280px]">
        <aside className="border-b border-[var(--jale-divider)] xl:border-b-0 xl:border-r">
          <div className="flex items-center justify-between border-b border-[var(--jale-divider)] px-4 py-3">
            <div>
              <p className="text-sm font-bold text-[var(--jale-ink)]">{t('threads')}</p>
              <p className="text-[11px] text-muted-foreground">{t('whatsapp_linked')}</p>
            </div>
            <span className="rounded-full bg-[#25D366] px-2 py-0.5 text-[10px] font-bold text-white">
              {openCount}
            </span>
          </div>
          {loadingList ? (
            <p className="p-4 text-sm text-muted">{tCommon('loading')}</p>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t('empty')}</p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto xl:max-h-[640px]">
              {conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={[
                    'flex w-full gap-3 border-b border-[#f0f2f5] px-4 py-3 text-left transition-colors',
                    selectedId === item.id ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[#fafbfd]',
                  ].join(' ')}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-[11px] font-extrabold text-[var(--jale-blue-700)]">
                    {initialsFor(item.worker_name ?? t('unknown_worker'))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-bold text-[var(--jale-ink)]">
                        {item.worker_name ?? t('unknown_worker')}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">
                        {formatRelativeTime(item.last_message_at ?? item.updated_at)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.job_title}</span>
                    <span className="mt-1 flex items-center gap-2">
                      <span
                        className={[
                          'h-1.5 w-1.5 rounded-full',
                          item.status === 'open' ? 'bg-[#25D366]' : 'bg-[var(--jale-ink-2)]',
                        ].join(' ')}
                      />
                      <span className="truncate text-xs text-muted">
                        {item.last_message_preview ?? t('no_messages')}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <div className="min-w-0">
          <ConversationThread
            conversation={conversation}
            messages={messages}
            loading={loadingThread}
            sending={sending}
            onSend={handleSend}
            onClose={conversation?.status === 'open' ? handleClose : undefined}
          />
        </div>

        <aside className="hidden border-l border-[var(--jale-divider)] bg-[#fbfcff] xl:block">
          <div className="border-b border-[var(--jale-divider)] px-4 py-3">
            <p className="text-sm font-bold text-[var(--jale-ink)]">{t('thread_status')}</p>
            <p className="text-[11px] text-muted-foreground">{t('current_handoff')}</p>
          </div>
          {selectedSummary ? (
            <div className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-sm font-extrabold text-[var(--jale-blue-700)]">
                  {initialsFor(selectedSummary.worker_name ?? t('unknown_worker'))}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--jale-ink)]">
                    {selectedSummary.worker_name ?? t('unknown_worker')}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{selectedSummary.job_title}</p>
                </div>
              </div>
              <StatusRow label={t('conversation')} value={selectedSummary.status === 'open' ? t('status_open') : t('status_closed')} tone={selectedSummary.status === 'open' ? 'green' : 'gray'} />
              <StatusRow label={t('worker_reply')} value={selectedSummary.last_worker_message_at ? t('received') : t('waiting')} tone={selectedSummary.last_worker_message_at ? 'green' : 'amber'} />
              <StatusRow label={t('channel')} value="WhatsApp" tone="blue" />
              <div className="rounded-lg border border-[var(--jale-divider)] bg-white p-3">
                <p className="text-xs font-bold uppercase text-muted">{t('latest_message')}</p>
                <p className="mt-2 text-sm leading-relaxed text-[var(--jale-ink)]">
                  {selectedSummary.last_message_preview ?? t('no_messages')}
                </p>
              </div>
            </div>
          ) : (
            <p className="p-4 text-sm text-muted">{t('empty_select')}</p>
          )}
        </aside>
      </section>
    </main>
  );
}

function MetricValue({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="text-2xl font-extrabold leading-none text-[var(--jale-blue-500)]">{value}</p>
      <p className="mt-1 text-[10px] font-semibold uppercase text-white/40">{label}</p>
    </div>
  );
}

function MetricCard({
  tone,
  value,
  label,
  detail,
}: {
  tone: 'blue' | 'green' | 'amber' | 'navy';
  value: number;
  label: string;
  detail: string;
}) {
  const toneClass = {
    blue: 'before:bg-[var(--jale-blue-500)] text-[var(--jale-blue-500)]',
    green: 'before:bg-[var(--jale-success)] text-[var(--jale-success)]',
    amber: 'before:bg-[var(--jale-warning)] text-[var(--jale-warning)]',
    navy: 'before:bg-[var(--jale-blue-900)] text-[var(--jale-blue-900)]',
  }[tone];

  return (
    <div className={`relative overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-white p-4 before:absolute before:left-0 before:right-0 before:top-0 before:h-1 ${toneClass}`}>
      <p className="text-2xl font-extrabold leading-none">{value}</p>
      <p className="mt-2 text-sm font-bold text-[var(--jale-ink)]">{label}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'blue' | 'green' | 'amber' | 'gray';
}) {
  const toneClass = {
    blue: 'bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]',
    green: 'bg-[var(--jale-success-bg)] text-[#1f7a44]',
    amber: 'bg-[var(--jale-warning-bg)] text-[#8a4400]',
    gray: 'bg-[var(--jale-paper-2)] text-[var(--jale-ink-2)]',
  }[tone];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${toneClass}`}>{value}</span>
    </div>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function formatRelativeTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
