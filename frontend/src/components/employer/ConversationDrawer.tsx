'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from '@/i18n/navigation';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Skeleton, SkeletonCircle, SkeletonLine } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import {
  ConversationThread,
  formatMessageTime,
  initialsFor,
} from '@/components/employer/ConversationThread';
import { isLegalWallError } from '@/lib/api';
import {
  closeConversation,
  getConversation,
  getConversations,
  sendConversationMessage,
} from '@/lib/api/employer';
import type {
  EmployerConversationResponse,
  EmployerConversationSummary,
} from '@/lib/api/employer';

/**
 * The floating conversations drawer, mounted in the root layout on EVERY page.
 *
 * Two things follow from "every page" and are easy to get wrong:
 *
 *  - Both `usePageData` instances pass `requireAuth: false`. The default arms a
 *    redirect to /auth for anyone without a session, and this component renders
 *    on the public landing page too -- the default would bounce every anonymous
 *    visitor off the marketing site. The legal-wall handling is still wanted,
 *    which is why the hook is used rather than hand-rolled.
 *  - Nothing is fetched until the drawer is actually opened by an employer.
 *    `canFetch` is in `deps`, so closing the drawer aborts whatever was in
 *    flight and stops the poll instead of leaving it running behind a closed
 *    panel.
 *
 * Send and close follow the same contract as the conversations page, because
 * both surfaces render the same `ConversationThread`: `onSend`/`onClose` reject
 * on failure, the draft survives, and the dialog reports it.
 */

const RETURN_URL = '/employer/conversations';
const THREAD_POLL_MS = 15000;

export function ConversationDrawer() {
  const { idToken, isAuthenticated, userType } = useAuth();
  const router = useRouter();
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const translateError = useErrorMessage();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pollNoticeDismissed, setPollNoticeDismissed] = useState(false);

  const isEmployer = userType === 'employer';
  const canFetch = open && isEmployer;

  const routeLegalWall = useCallback(
    (err: unknown): boolean => {
      if (!isLegalWallError(err)) return false;
      sessionStorage.setItem('legalReturnUrl', RETURN_URL);
      router.replace('/legal/accept');
      return true;
    },
    [router],
  );

  const list = usePageData<EmployerConversationSummary[] | null>({
    fetcher: async ({ token, signal }) => {
      if (!canFetch) return null;
      const res = await getConversations(token, signal);
      return res.conversations.filter((item) => item.status === 'open');
    },
    requireAuth: false,
    legalReturnUrl: RETURN_URL,
    deps: [canFetch],
    isEmpty: (data) => data !== null && data.length === 0,
  });

  const { setData: setListData } = list;
  const conversations = list.data ?? [];

  const thread = usePageData<EmployerConversationResponse | null>({
    fetcher: ({ token, signal }) =>
      canFetch && selectedId ? getConversation(token, selectedId, signal) : Promise.resolve(null),
    requireAuth: false,
    legalReturnUrl: RETURN_URL,
    deps: [canFetch, selectedId],
    pollMs: canFetch && selectedId ? THREAD_POLL_MS : undefined,
  });

  const { setData: setThreadData, refresh: refreshThread, refreshError: threadRefreshError } = thread;

  const conversation = thread.data?.conversation ?? null;
  const messages = thread.data?.messages ?? [];

  // A composer error belongs to the thread it was raised in.
  useEffect(() => {
    setComposerError(null);
  }, [selectedId]);

  // Dismissing the poll banner silences this outage, not every future one.
  useEffect(() => {
    if (threadRefreshError === null) setPollNoticeDismissed(false);
  }, [threadRefreshError]);

  async function handleSend(body: string) {
    if (!idToken || !selectedId) return;
    setSending(true);
    setComposerError(null);
    try {
      const detail = await sendConversationMessage(idToken, selectedId, body);
      setThreadData(detail);
      setListData((prev) =>
        (prev ?? []).map((item) =>
          item.id === detail.conversation.id
            ? {
                ...item,
                last_message_at: detail.conversation.last_message_at,
                last_message_preview: detail.conversation.last_message_preview,
              }
            : item,
        ),
      );
    } catch (err) {
      if (!routeLegalWall(err)) setComposerError(translateError(err));
      // Re-raised so `ConversationThread` keeps the draft it would otherwise
      // clear. The line above is what the user reads; this is what they keep.
      throw err;
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedId) return;
    const closedId = selectedId;
    setClosing(true);
    try {
      await closeConversation(idToken, closedId);
      // The drawer only ever lists OPEN threads, so a closed one leaves it.
      setListData((prev) => (prev ?? []).filter((item) => item.id !== closedId));
      setSelectedId(null);
      toast.success(t('conversation_closed'));
    } catch (err) {
      routeLegalWall(err);
      // Rejected so the confirmation dialog stays open and explains itself.
      throw err;
    } finally {
      setClosing(false);
    }
  }

  // Every hook above runs unconditionally; only the OUTPUT is gated. Workers and
  // signed-out visitors never see the drawer, and `canFetch` keeps them from
  // ever hitting an employer endpoint.
  if (!isAuthenticated || !isEmployer) return null;

  const listBusy = list.phase === 'auth' || list.phase === 'loading';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="fixed bottom-5 right-5 z-30 inline-flex cursor-pointer items-center gap-2 rounded-full bg-[var(--jale-blue-900)] px-4 py-3 text-sm font-bold text-white shadow-[var(--shadow-modal)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {/* WhatsApp brand green -- the one sanctioned literal, same in both themes. */}
        <span className="h-2 w-2 rounded-full bg-[#25D366]" />
        {open ? t('drawer_close') : t('drawer_button')}
      </button>

      {open ? (
        <div className="anim-fade-in fixed bottom-20 right-5 z-30 flex h-[620px] max-h-[calc(100vh-7rem)] w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-modal)]">
          {/* List pane. Below sm it owns the whole drawer until a thread is
              picked -- a 240px list and a transcript will not share 358px. */}
          <aside
            className={[
              'min-w-0 flex-col border-[var(--jale-divider)] bg-[var(--jale-paper-2)] sm:flex sm:w-60 sm:shrink-0 sm:border-r',
              selectedId ? 'hidden' : 'flex w-full',
            ].join(' ')}
          >
            <div className="shrink-0 border-b border-[var(--jale-divider)] bg-[var(--jale-blue-900)] p-3 text-white">
              <p className="text-sm font-bold">{t('title')}</p>
              <p className="mt-0.5 text-[11px] text-white/45">WhatsApp</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {listBusy ? (
                <ConversationListSkeleton label={tCommon('loading')} />
              ) : list.phase === 'error' && list.errorKind ? (
                <ErrorState kind={list.errorKind} onRetry={list.retry} compact />
              ) : conversations.length === 0 ? (
                <EmptyState icon="message" variant="filtered" title={t('empty')} body={t('empty_drawer_body')} />
              ) : (
                <ul className="divide-y divide-[var(--jale-divider)]">
                  {conversations.map((item) => {
                    const name = item.worker_name ?? t('unknown_worker');
                    const selected = selectedId === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(item.id)}
                          aria-current={selected ? 'true' : undefined}
                          className={[
                            'flex w-full cursor-pointer gap-2 p-3 text-left transition-colors',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                            selected ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[var(--jale-card)]',
                          ].join(' ')}
                        >
                          <span className="avatar-initials h-8 w-8 shrink-0 text-[10px]">
                            {initialsFor(name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-sm font-bold text-[var(--jale-ink)]">{name}</span>
                              <span className="shrink-0 text-[10px] tabular-nums text-[var(--jale-ink-2)]">
                                {formatMessageTime(item.last_message_at)}
                              </span>
                            </span>
                            <span className="block truncate text-xs text-[var(--jale-ink-2)]">
                              {item.job_title}
                            </span>
                            <span className="mt-1 flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#25D366]" />
                              <span className="truncate text-[11px] text-[var(--jale-ink-2)]">
                                {item.last_message_preview ?? t('no_messages')}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          {/* Thread pane. */}
          <div
            className={[
              'min-w-0 flex-1 flex-col sm:flex',
              selectedId ? 'flex' : 'hidden',
            ].join(' ')}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--jale-divider)] bg-[var(--jale-blue-900)] p-3 text-white sm:hidden">
              <p className="truncate text-sm font-bold">{t('title')}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t('hide')}
              </Button>
            </div>

            {/* A failed poll over messages already on screen: a footnote, never
                a replacement for the transcript. */}
            {threadRefreshError !== null && !pollNoticeDismissed ? (
              <div className="shrink-0 border-b border-[var(--jale-divider)] p-2">
                <InlineFeedback tone="warning" onDismiss={() => setPollNoticeDismissed(true)}>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{tCommon('feedback.refresh_failed')}</span>
                    <button
                      type="button"
                      onClick={() => void refreshThread()}
                      className="cursor-pointer font-bold underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                    >
                      {tCommon('retry')}
                    </button>
                  </span>
                </InlineFeedback>
              </div>
            ) : null}

            {!selectedId ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState icon="message" title={t('empty_select')} body={t('empty_select_body')} />
              </div>
            ) : thread.phase === 'error' && thread.errorKind ? (
              <div className="flex flex-1 items-center justify-center">
                <ErrorState kind={thread.errorKind} onRetry={thread.retry} compact />
              </div>
            ) : (
              <ConversationThread
                key={selectedId}
                conversation={conversation}
                messages={messages}
                loading={thread.phase !== 'ready'}
                sending={sending}
                closing={closing}
                errorMessage={composerError}
                onSend={handleSend}
                onClose={conversation?.status === 'open' ? handleClose : undefined}
                onBack={() => setSelectedId(null)}
                backHiddenFrom="sm"
                compact
              />
            )}
          </div>
        </div>
      ) : null}
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
      <ul className="divide-y divide-[var(--jale-divider)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="flex w-full gap-2 p-3">
            <SkeletonCircle size={32} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <SkeletonLine width="w-2/3" />
              <SkeletonLine width="w-1/2" tone="paper" />
              <Skeleton className="h-2.5 w-3/4" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
