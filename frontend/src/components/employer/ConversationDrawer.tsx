'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from '@/i18n/navigation';
import { LegalWallError } from '@/lib/api';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Skeleton, SkeletonCircle, SkeletonLine } from '@/components/ui/skeleton';
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
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
  const [open, setOpen] = useState(false);
  const [conversations, setConversations] = useState<EmployerConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<EmployerConversationDetail | null>(null);
  const [messages, setMessages] = useState<EmployerConversationMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);

  // Distinguishing "still fetching the list" from "the list is empty" is the
  // whole point of this flag: without it the drawer opened onto "No
  // conversations" every single time and then filled in, which reads as a bug.
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  /** Failure of a send/close, shown against the composer. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** A poll tick failed over messages already on screen. */
  const [threadRefreshFailed, setThreadRefreshFailed] = useState(false);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [threadReloadToken, setThreadReloadToken] = useState(0);

  function handleDrawerLegalWall(err: unknown) {
    if (err instanceof LegalWallError) {
      sessionStorage.setItem('legalReturnUrl', '/employer/conversations');
      router.replace('/legal/accept');
    }
  }

  useEffect(() => {
    if (!open || !idToken || userType !== 'employer') return;
    let active = true;
    setListLoading(true);
    setListError(null);
    getConversations(idToken)
      .then((res) => {
        if (!active) return;
        const openConversations = res.conversations.filter((item) => item.status === 'open');
        setConversations(openConversations);
        setSelectedId((current) => current ?? openConversations[0]?.id ?? null);
      })
      .catch((err) => {
        if (!active) return;
        handleDrawerLegalWall(err);
        // The legal wall is a redirect, not a message: showing an error under
        // it would be a screen the user cannot act on.
        if (!(err instanceof LegalWallError)) setListError(errorMessage(err));
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => { active = false; };
  }, [open, idToken, userType, listReloadToken]);

  useEffect(() => {
    if (!open || !idToken || !selectedId) return;
    let active = true;
    let firstLoad = true;
    // Tracks whether messages have EVER arrived for this thread, which is what
    // separates "the thread failed to load" from "a refresh of a thread the
    // user is reading failed". The second must never clear the transcript.
    let loadedOnce = false;

    async function load() {
      if (firstLoad) {
        setLoading(true);
        setThreadError(null);
      }
      try {
        const detail = await getConversation(idToken!, selectedId!);
        if (!active) return;
        setConversation(detail.conversation);
        setMessages(detail.messages);
        setThreadError(null);
        setThreadRefreshFailed(false);
        loadedOnce = true;
      } catch (err) {
        if (!active) return;
        handleDrawerLegalWall(err);
        if (err instanceof LegalWallError) return;
        if (loadedOnce) {
          // Keep the last messages on screen; just say we are retrying.
          setThreadRefreshFailed(true);
        } else {
          setThreadError(errorMessage(err));
        }
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
  }, [open, idToken, selectedId, threadReloadToken, router]);

  if (!isAuthenticated || userType !== 'employer') return null;

  async function handleSend(body: string) {
    if (!idToken || !selectedId) return;
    setSending(true);
    setActionError(null);
    try {
      const detail = await sendConversationMessage(idToken, selectedId, body);
      setConversation(detail.conversation);
      setMessages(detail.messages);
    } catch (err) {
      handleDrawerLegalWall(err);
      if (!(err instanceof LegalWallError)) setActionError(errorMessage(err));
      // Re-raised deliberately. ConversationThread clears the composer only
      // when onSend RESOLVES, so swallowing here would delete the message the
      // user just typed. The banner above is the user-facing handling; the
      // rejection is what preserves their draft so they can retry.
      throw err;
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedId) return;
    setClosing(true);
    setActionError(null);
    try {
      const detail = await closeConversation(idToken, selectedId);
      setConversation(detail.conversation);
      setMessages(detail.messages);
      setConversations((current) => current.filter((item) => item.id !== selectedId));
      setSelectedId(null);
    } catch (err) {
      // Nothing to preserve here (no draft), so this one is fully handled: a
      // failed close used to reject into nowhere and leave the button spinning
      // back to idle with no explanation.
      handleDrawerLegalWall(err);
      if (!(err instanceof LegalWallError)) setActionError(errorMessage(err));
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
              {listLoading ? (
                <ConversationListSkeleton label={tCommon('loading')} />
              ) : listError ? (
                <div className="p-3">
                  <InlineFeedback tone="danger">
                    <span className="block">{listError}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => setListReloadToken((n) => n + 1)}
                    >
                      {tCommon('retry')}
                    </Button>
                  </InlineFeedback>
                </div>
              ) : conversations.length === 0 ? (
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

            {/* Transient: the transcript below is still the last known good one. */}
            {threadRefreshFailed && !threadError ? (
              <div className="shrink-0 px-3 pt-2">
                <InlineFeedback tone="warning">{tCommon('feedback.refresh_failed')}</InlineFeedback>
              </div>
            ) : null}

            {threadError ? (
              <div className="flex flex-1 items-center justify-center p-4">
                <InlineFeedback tone="danger">
                  <span className="block">{threadError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => setThreadReloadToken((n) => n + 1)}
                  >
                    {tCommon('retry')}
                  </Button>
                </InlineFeedback>
              </div>
            ) : (
              <ConversationThread
                key={conversation?.id ?? 'none'}
                conversation={conversation}
                messages={messages}
                loading={loading}
                sending={sending}
                closing={closing}
                // ConversationThread already renders this against the composer
                // with role="alert" and aria-describedby on the textarea.
                errorMessage={actionError}
                onSend={handleSend}
                onClose={conversation?.status === 'open' ? handleClose : undefined}
                compact
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Placeholder rows traced from the real conversation buttons above (32px
 * avatar, three text lines, same 12px padding and divider), so the list does
 * not jump when the fetch lands.
 */
function ConversationListSkeleton({ label }: { label: string }) {
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex w-full gap-2 border-b border-[#f0f2f5] p-3">
          <SkeletonCircle size={32} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonLine width="w-2/3" />
            <SkeletonLine width="w-1/2" tone="paper" />
            <Skeleton className="h-2.5 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}
