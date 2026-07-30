'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { MetricCard } from '@/components/ui/metric-card';
import { ConversationThread } from '@/components/employer/ConversationThread';
import { EmptyThreadComposer } from '@/components/employer/EmptyThreadComposer';
import {
  closeConversation,
  getConversation,
  getInbox,
  sendConversationMessage,
  startConversation,
  updateApplicantStatus,
} from '@/lib/api/employer';
import type {
  EmployerConversationDetail,
  EmployerConversationMessage,
  InboxItem,
  InboxJob,
  InboxTab,
} from '@/lib/api/employer';

export default function EmployerConversationsPage() {
  const searchParams = useSearchParams();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');

  const [items, setItems] = useState<InboxItem[]>([]);
  const [jobs, setJobs] = useState<InboxJob[]>([]);
  const [tab, setTab] = useState<InboxTab>('active');
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [conversation, setConversation] = useState<EmployerConversationDetail | null>(null);
  const [messages, setMessages] = useState<EmployerConversationMessage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);

  const selectedItem = items.find((item) => item.application_id === selectedKey) ?? null;
  const selectedConversationId = selectedItem?.conversation_id ?? null;

  const conversationRef = useRef(conversation);
  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  useEffect(() => {
    if (!idToken) return;
    let active = true;
    setLoadingList(true);
    const deepLinkConversationId = searchParams.get('conversation_id');

    getInbox(idToken)
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setJobs(res.jobs);
        const deepLinked = deepLinkConversationId
          ? res.items.find((item) => item.conversation_id === deepLinkConversationId)
          : undefined;
        if (deepLinked) {
          setTab(deepLinked.tab);
          setSelectedKey(deepLinked.application_id);
        } else {
          setSelectedKey((current) => current
            ?? res.items.find((item) => item.tab === 'active')?.application_id
            ?? null);
        }
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
    setThreadError(null);
    if (!idToken || !selectedConversationId) {
      setConversation(null);
      setMessages([]);
      return;
    }
    let active = true;
    let firstLoad = true;

    async function loadThread() {
      if (firstLoad && conversationRef.current?.id !== selectedConversationId) {
        setLoadingThread(true);
      }
      try {
        const detail = await getConversation(idToken!, selectedConversationId!);
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
  }, [idToken, selectedConversationId]);

  function applyConversationToItems(detail: EmployerConversationDetail, applicationId: string) {
    setItems((current) => current.map((item) => (
      item.application_id === applicationId
        ? {
            ...item,
            conversation_id: detail.id,
            conversation_status: detail.status,
            last_message_at: detail.last_message_at,
            last_worker_message_at: detail.last_worker_message_at,
            last_message_preview: detail.last_message_preview,
            application_status: item.application_status === 'pending' ? 'contacted' : item.application_status,
          }
        : item
    )));
  }

  async function handleSend(body: string) {
    if (!idToken || !selectedItem || !selectedConversationId) return;
    setSending(true);
    try {
      const detail = await sendConversationMessage(idToken, selectedConversationId, body);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      applyConversationToItems(detail.conversation, selectedItem.application_id);
    } finally {
      setSending(false);
    }
  }

  async function handleFirstSend(body: string): Promise<boolean> {
    if (!idToken || !selectedItem) return false;
    setSending(true);
    setThreadError(null);
    try {
      const detail = await startConversation(idToken, {
        job_id: selectedItem.job_id,
        worker_id: selectedItem.worker_id,
        initial_message: body,
      });
      setConversation(detail.conversation);
      setMessages(detail.messages);
      applyConversationToItems(detail.conversation, selectedItem.application_id);
      return true;
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      if (code === 'worker_whatsapp_unavailable') {
        setThreadError(t('worker_whatsapp_unavailable'));
      } else if (code === 'applicant_not_found') {
        setThreadError(t('candidate_unavailable'));
        const res = await getInbox(idToken).catch(() => null);
        if (res) { setItems(res.items); setJobs(res.jobs); }
      } else {
        setThreadError(tCommon('error'));
      }
      return false;
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedItem || !selectedConversationId) return;
    const detail = await closeConversation(idToken, selectedConversationId);
    setConversation(detail.conversation);
    setMessages(detail.messages);
    applyConversationToItems(detail.conversation, selectedItem.application_id);
  }

  async function handleDismiss() {
    if (!idToken || !selectedItem) return;
    if (!window.confirm(t('not_interested_confirm'))) return;
    try {
      await updateApplicantStatus(idToken, selectedItem.job_id, selectedItem.worker_id, 'not_interested');
      setItems((current) => current.filter((item) => item.application_id !== selectedItem.application_id));
      setSelectedKey(null);
      setConversation(null);
      setMessages([]);
    } catch {
      setThreadError(tCommon('error'));
    }
  }

  function switchTab(next: InboxTab) {
    setTab(next);
    setJobFilter(null);
    setSelectedKey((current) => {
      const stillVisible = items.some((item) => item.application_id === current && item.tab === next);
      return stillVisible ? current : null;
    });
  }

  const visibleItems = items.filter((item) => (
    item.tab === tab && (!jobFilter || item.job_id === jobFilter)
  ));
  const activeItems = items.filter((item) => item.tab === 'active');
  const newApplicantCount = activeItems.filter((item) => !item.conversation_id).length;
  const repliedCount = activeItems.filter((item) => item.conversation_id && item.last_worker_message_at).length;
  const waitingCount = activeItems.filter((item) => item.conversation_id && !item.last_worker_message_at).length;

  if (error) {
    return (
      <AppShell role="employer" title={t('title')} subtitle={t('subtitle')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
          <p className="text-sm text-error">{error}</p>
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell role="employer" title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-7xl px-4 py-6">
      <section className="mb-5 grid gap-3 md:grid-cols-4">
        <MetricCard variant="accent" tone="blue" value={activeItems.length} label={t('candidates')} hint={t('subtitle')} />
        <MetricCard variant="accent" tone="green" value={repliedCount} label={t('worker_replied')} hint={t('reply_window_open')} />
        <MetricCard variant="accent" tone="amber" value={waitingCount} label={t('waiting_reply')} hint={t('template_invite_sent')} />
        <MetricCard variant="accent" tone="navy" value={newApplicantCount} label={t('new_applicants')} hint={t('not_yet_messaged')} />
      </section>

      <section className="grid min-h-[680px] overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-white shadow-sm xl:grid-cols-[320px_minmax(0,1fr)_280px]">
        <aside className="border-b border-[var(--jale-divider)] xl:border-b-0 xl:border-r">
          <div className="border-b border-[var(--jale-divider)] px-4 py-3">
            <div className="flex rounded-md bg-[var(--jale-paper-2)] p-0.5">
              {(['active', 'closed'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchTab(value)}
                  className={[
                    'flex-1 rounded px-3 py-1.5 text-xs font-bold transition-colors',
                    tab === value
                      ? 'bg-white text-[var(--jale-ink)] shadow-sm'
                      : 'text-muted-foreground hover:text-[var(--jale-ink)]',
                  ].join(' ')}
                >
                  {value === 'active' ? t('tab_active') : t('tab_closed')}
                </button>
              ))}
            </div>
            {jobs.length > 1 && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setJobFilter(null)}
                  className={[
                    'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    jobFilter === null
                      ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                      : 'border-[var(--jale-divider)] text-muted-foreground hover:bg-[#fafbfd]',
                  ].join(' ')}
                >
                  {t('all_jobs')}
                </button>
                {jobs.map((job) => (
                  <button
                    key={job.job_id}
                    type="button"
                    onClick={() => setJobFilter((current) => (current === job.job_id ? null : job.job_id))}
                    className={[
                      'max-w-[160px] shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                      jobFilter === job.job_id
                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                        : 'border-[var(--jale-divider)] text-muted-foreground hover:bg-[#fafbfd]',
                    ].join(' ')}
                  >
                    {job.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          {loadingList ? (
            <p className="p-4 text-sm text-muted">{tCommon('loading')}</p>
          ) : visibleItems.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              {tab === 'active' ? t('empty_tab_active') : t('empty_tab_closed')}
            </p>
          ) : (
            <div className="max-h-[300px] overflow-y-auto xl:max-h-[560px]">
              {visibleItems.map((item) => (
                <button
                  key={item.application_id}
                  type="button"
                  onClick={() => setSelectedKey(item.application_id)}
                  className={[
                    'flex w-full gap-3 border-b border-[#f0f2f5] px-4 py-3 text-left transition-colors',
                    selectedKey === item.application_id ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[#fafbfd]',
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
                        {formatRelativeTime(item.last_message_at ?? item.applied_at)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.job_title}</span>
                    {item.conversation_id ? (
                      <span className="mt-1 flex items-center gap-2">
                        <span
                          className={[
                            'h-1.5 w-1.5 rounded-full',
                            item.conversation_status === 'open' ? 'bg-[#25D366]' : 'bg-[var(--jale-ink-2)]',
                          ].join(' ')}
                        />
                        <span className="truncate text-xs text-muted">
                          {item.last_message_preview ?? t('no_messages')}
                        </span>
                      </span>
                    ) : (
                      <span className="mt-1 inline-flex items-center rounded-full bg-[var(--jale-blue-50)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--jale-blue-700)]">
                        {t('new_applicant')}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <div className="min-w-0">
          {selectedItem && !selectedConversationId ? (
            <EmptyThreadComposer
              item={selectedItem}
              sending={sending}
              errorMessage={threadError}
              onSend={handleFirstSend}
              onDismiss={handleDismiss}
            />
          ) : (
            <ConversationThread
              conversation={conversation}
              messages={messages}
              loading={loadingThread}
              sending={sending}
              errorMessage={threadError}
              onSend={handleSend}
              onClose={conversation?.status === 'open' ? handleClose : undefined}
              onDismiss={selectedItem ? handleDismiss : undefined}
            />
          )}
        </div>

        <aside className="hidden border-l border-[var(--jale-divider)] bg-[#fbfcff] xl:block">
          <div className="border-b border-[var(--jale-divider)] px-4 py-3">
            <p className="text-sm font-bold text-[var(--jale-ink)]">{t('thread_status')}</p>
            <p className="text-[11px] text-muted-foreground">{t('current_handoff')}</p>
          </div>
          {selectedItem ? (
            <div className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--jale-blue-50)] text-sm font-extrabold text-[var(--jale-blue-700)]">
                  {initialsFor(selectedItem.worker_name ?? t('unknown_worker'))}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--jale-ink)]">
                    {selectedItem.worker_name ?? t('unknown_worker')}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{selectedItem.job_title}</p>
                </div>
              </div>
              {selectedItem.conversation_id ? (
                <>
                  <StatusRow label={t('conversation')} value={selectedItem.conversation_status === 'open' ? t('status_open') : t('status_closed')} tone={selectedItem.conversation_status === 'open' ? 'green' : 'gray'} />
                  <StatusRow label={t('worker_reply')} value={selectedItem.last_worker_message_at ? t('received') : t('waiting')} tone={selectedItem.last_worker_message_at ? 'green' : 'amber'} />
                </>
              ) : (
                <StatusRow label={t('conversation')} value={t('new_applicant')} tone="blue" />
              )}
              <StatusRow label={t('channel')} value="WhatsApp" tone="blue" />
              <div className="rounded-lg border border-[var(--jale-divider)] bg-white p-3">
                <p className="text-xs font-bold uppercase text-muted">{t('latest_message')}</p>
                <p className="mt-2 text-sm leading-relaxed text-[var(--jale-ink)]">
                  {selectedItem.last_message_preview ?? t('no_messages')}
                </p>
              </div>
            </div>
          ) : (
            <p className="p-4 text-sm text-muted">{t('empty_select')}</p>
          )}
        </aside>
      </section>
      </div>
    </AppShell>
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
