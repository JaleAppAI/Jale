'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useConversationDrawer } from '@/contexts/ConversationDrawerContext';
import type { ConversationTarget } from '@/contexts/ConversationDrawerContext';
import { useUnreadMessages } from '@/contexts/UnreadMessagesContext';
import { useRouter } from '@/i18n/navigation';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { useThreadReadReceipt } from '@/hooks/useThreadReadReceipt';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Skeleton, SkeletonCircle, SkeletonLine } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { UnreadBadge } from '@/components/layout/UnreadBadge';
import {
  ConversationThread,
  initialsFor,
} from '@/components/employer/ConversationThread';
import { EmptyThreadComposer } from '@/components/employer/EmptyThreadComposer';
import type { ComposerSubject } from '@/components/employer/EmptyThreadComposer';
import { isLegalWallError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatTimeOfDay } from '@/lib/date';
import {
  closeConversation,
  getConversation,
  sendConversationMessage,
  startConversation,
} from '@/lib/api/employer';
import type { EmployerConversationResponse, InboxItem } from '@/lib/api/employer';

/**
 * The floating conversations drawer, mounted on EVERY page (by
 * `ConversationDrawerProvider`, which also owns the "open this applicant"
 * verb other surfaces call).
 *
 * WHERE ITS LIST COMES FROM changed in sprint 26 (B3/B4), and that is the
 * substance of this file. It used to fetch `GET /employer/conversations`
 * itself, on open. It now renders `UnreadMessagesContext`'s inbox, for two
 * reasons that are really one:
 *
 *  - `openConversation({ application_id, worker_id, job_id })` carries no
 *    conversation id, because the applicants board has none to give. Something
 *    has to resolve an APPLICATION to the thread it may or may not have, and
 *    the inbox is the only endpoint that answers that. A row whose applicant
 *    has never been messaged must land on the first-message composer, and
 *    `/employer/conversations` cannot even see such an applicant;
 *  - one inbox read for the session, rather than a second list endpoint polled
 *    beside it.
 *
 * The list still shows open threads, newest first (the server already orders
 * the inbox that way), with ONE deliberate difference: the inbox excludes
 * applications the employer has dismissed (`ja.status <> 'not_interested'`),
 * so an open thread with a dismissed applicant no longer appears here. That is
 * the wanted reading of "not interested" -- the conversations board has said
 * the same thing since the inbox shipped -- rather than an accident of the new
 * source. (The inbox is also capped at 200 rows; the drawer is a recent-threads
 * panel, not an archive, and the board is the full surface.)
 *
 * Which leaves the applicants the inbox does NOT carry, and this is the other
 * half of resolving an application here: a never-messaged applicant of a job
 * that is no longer active is absent from the inbox by that same `c.id IS NOT
 * NULL OR j.status = 'active'` clause, and so is anyone past its 200-row cap --
 * while the applicants board lists all of them and the API would accept the
 * message. They are drawn from the fields the opening request carries (see
 * `ConversationTarget`); "This candidate is no longer available" is kept for
 * the case it describes, a request that names nobody this drawer can draw.
 *
 * The selected item is looked up in the FULL item set, not the filtered list,
 * which is exactly how the conversations page separates "what the list shows"
 * from "what is open" -- and it is what lets an applicant with no thread yet be
 * opened without appearing in a list of conversations that do not exist.
 *
 * Send and close follow the same contract as the conversations page, because
 * both surfaces render the same `ConversationThread`: `onSend`/`onClose`
 * reject on failure, the draft survives, and the dialog reports it. Both then
 * ask the context to refresh rather than patching a list they no longer own.
 */

const RETURN_URL = '/employer/conversations';
const THREAD_POLL_MS = 15000;

export function ConversationDrawer() {
  const { idToken, isAuthenticated, userType } = useAuth();
  const router = useRouter();
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const translateError = useErrorMessage();
  const toast = useToast();

  const { items, loading: inboxLoading, errorKind: inboxErrorKind, retry: retryInbox, refresh, unreadByConversation, unreadCount } =
    useUnreadMessages();
  const { openRequest } = useConversationDrawer();

  const [open, setOpen] = useState(false);
  /** The selected APPLICATION, not conversation -- see the header note. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pollNoticeDismissed, setPollNoticeDismissed] = useState(false);
  /**
   * Threads this drawer has just STARTED, by application id. The inbox learns
   * about them on its next read; until then this is what moves the pane from
   * the first-message composer to the transcript the employer just created.
   */
  const [startedThreads, setStartedThreads] = useState<Record<string, string>>({});

  const isEmployer = userType === 'employer';
  const canFetch = open && isEmployer;

  /*
   * A request from elsewhere in the app ("Message" on an applicant row).
   * Applied by TOKEN rather than by target, so asking twice for the same
   * applicant re-opens a drawer the employer has since closed.
   */
  const appliedRequestRef = useRef(0);
  useEffect(() => {
    if (!openRequest || openRequest.token === appliedRequestRef.current) return;
    appliedRequestRef.current = openRequest.token;
    setSelectedKey(openRequest.target.application_id);
    setOpen(true);
    // The applicant may have applied since the last poll, or been messaged
    // from another device; ask before deciding they are unreachable.
    void refresh();
  }, [openRequest, refresh]);

  const threads = useMemo(
    () => items.filter((item) => item.conversation_id && item.conversation_status === 'open'),
    [items],
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.application_id === selectedKey) ?? null,
    [items, selectedKey],
  );

  /**
   * The request currently on screen, when the employer has not since picked a
   * different row. It is the ONLY description of an applicant the inbox does
   * not list, so it is what the composer falls back to below.
   */
  const pendingTarget: ConversationTarget | null =
    openRequest && openRequest.target.application_id === selectedKey ? openRequest.target : null;

  /*
   * A thread started here is keyed by APPLICATION, which is why this survives
   * the inbox not knowing the applicant: the employer lands on the transcript
   * they just created rather than on their own composer, one inbox poll early.
   */
  const selectedConversationId = selectedKey
    ? selectedItem?.conversation_id ?? startedThreads[selectedKey] ?? null
    : null;

  /**
   * Who the first-message pane draws. The inbox row when there is one; failing
   * that, the fields the calling surface passed -- the applicants board lists
   * applicants the inbox does not (see `ConversationTarget`), and those are
   * exactly the rows that used to open on "no longer available".
   *
   * `null` while the inbox is still loading, so a row that IS in the inbox
   * (possibly with a thread already) is never briefly drawn as a new applicant.
   */
  const composerSubject: ComposerSubject | null =
    selectedItem ?? (inboxLoading ? null : composerSubjectFor(pendingTarget));

  const routeLegalWall = useCallback(
    (err: unknown): boolean => {
      if (!isLegalWallError(err)) return false;
      sessionStorage.setItem('legalReturnUrl', RETURN_URL);
      router.replace('/legal/accept');
      return true;
    },
    [router],
  );

  const thread = usePageData<EmployerConversationResponse | null>({
    fetcher: ({ token, signal }) =>
      canFetch && selectedConversationId
        ? getConversation(token, selectedConversationId, signal)
        : Promise.resolve(null),
    requireAuth: false,
    legalReturnUrl: RETURN_URL,
    deps: [canFetch, selectedConversationId],
    pollMs: canFetch && selectedConversationId ? THREAD_POLL_MS : undefined,
  });

  const { setData: setThreadData, refresh: refreshThread, refreshError: threadRefreshError } = thread;

  const conversation = thread.data?.conversation ?? null;
  const messages = thread.data?.messages ?? [];

  /*
   * Reading a thread here clears its badge everywhere, once per open and again
   * when a new worker message lands while the drawer is on screen. The stamp
   * comes from the inbox item rather than the transcript -- see the hook.
   */
  useThreadReadReceipt({
    conversationId: selectedConversationId,
    lastWorkerMessageAt: selectedItem?.last_worker_message_at ?? null,
    active: canFetch,
  });

  // A composer error belongs to the thread it was raised in.
  useEffect(() => {
    setComposerError(null);
  }, [selectedKey]);

  // Dismissing the poll banner silences this outage, not every future one.
  useEffect(() => {
    if (threadRefreshError === null) setPollNoticeDismissed(false);
  }, [threadRefreshError]);

  async function handleSend(body: string) {
    if (!idToken || !selectedConversationId) return;
    setSending(true);
    setComposerError(null);
    try {
      const detail = await sendConversationMessage(idToken, selectedConversationId, body);
      setThreadData(detail);
      // The list's preview and ordering belong to the inbox now.
      void refresh();
    } catch (err) {
      if (!routeLegalWall(err)) setComposerError(translateError(err));
      // Re-raised so `ConversationThread` keeps the draft it would otherwise
      // clear. The line above is what the user reads; this is what they keep.
      throw err;
    } finally {
      setSending(false);
    }
  }

  async function handleFirstSend(body: string) {
    /*
     * The applicant being written to: the inbox row when there is one, and
     * otherwise the request that opened this pane. A missing subject THROWS
     * rather than returning quietly -- `EmptyThreadComposer` clears the draft
     * on a resolved promise, so a bare `return` would swallow the employer's
     * first message.
     */
    const subject = selectedItem ?? pendingTarget;
    if (!idToken || !subject) throw new Error('No applicant to write to');
    setSending(true);
    setComposerError(null);
    try {
      const detail = await startConversation(idToken, {
        job_id: subject.job_id,
        worker_id: subject.worker_id,
        initial_message: body,
      });
      setStartedThreads((prev) => ({ ...prev, [subject.application_id]: detail.conversation.id }));
      void refresh();
    } catch (err) {
      if (!routeLegalWall(err)) {
        // Two refusals specific enough to deserve their own sentence; the
        // generic classifier would flatten both into "check your input".
        const code = err instanceof ApiError ? err.code : null;
        if (code === 'worker_whatsapp_unavailable') {
          setComposerError(t('worker_whatsapp_unavailable'));
        } else if (code === 'applicant_not_found') {
          setComposerError(t('candidate_unavailable'));
          void refresh();
        } else {
          setComposerError(translateError(err));
        }
      }
      throw err;
    } finally {
      setSending(false);
    }
  }

  async function handleClose() {
    if (!idToken || !selectedConversationId) return;
    setClosing(true);
    try {
      await closeConversation(idToken, selectedConversationId);
      // The drawer only ever lists OPEN threads; the server owns which tab a
      // closed one belongs to, so ask it rather than guessing here.
      void refresh();
      setSelectedKey(null);
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
  // signed-out visitors never see the drawer, and the context behind `items`
  // never touches an employer endpoint for them either.
  if (!isAuthenticated || !isEmployer) return null;

  return (
    <>
      {/*
       * Below `lg` the employer shell now has a bottom tab bar (5rem + the
       * safe-area inset). This launcher is `z-30` against the bar's `z-20`, so
       * left at `bottom-5` it would sit on top of the bar and swallow the
       * rightmost tabs. Both fixed pieces clear the bar's height at mobile
       * widths and keep their original offsets from `lg` up, where the bar is
       * hidden and the sidebar takes over.
       */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-5 z-30 inline-flex cursor-pointer items-center gap-2 rounded-full bg-[var(--jale-blue-900)] px-4 py-3 text-sm font-bold text-white shadow-[var(--shadow-modal)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] lg:bottom-5"
      >
        {/*
         * The count, when there is one. This used to be a fixed WhatsApp-green
         * dot -- a decoration that looked exactly the same whether three
         * workers were waiting on an answer or none were.
         */}
        {unreadCount > 0 ? (
          <UnreadBadge count={unreadCount} tone="rail" />
        ) : (
          /* WhatsApp brand green -- the one sanctioned literal, same in both themes. */
          <span className="h-2 w-2 rounded-full bg-[#25D366]" />
        )}
        {open ? t('drawer_close') : t('drawer_button')}
      </button>

      {/*
       * The panel grows upward from its `bottom` offset, so the safe-area inset
       * that pushed that offset up has to come out of the height budget too --
       * otherwise the top edge runs off the viewport by exactly the inset on a
       * notched phone. Mobile: a 10rem + inset offset, with 2rem of breathing
       * room left above. From `lg` the tab bar is gone and both revert to the
       * original 5rem/2rem pair.
       */}
      {open ? (
        <div className="anim-fade-in fixed bottom-[calc(10rem+env(safe-area-inset-bottom))] right-5 z-30 flex h-[620px] max-h-[calc(100vh-12rem-env(safe-area-inset-bottom))] w-[min(760px,calc(100vw-2rem))] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-modal)] lg:bottom-20 lg:max-h-[calc(100vh-7rem)]">
          {/* List pane. Below sm it owns the whole drawer until a thread is
              picked -- a 240px list and a transcript will not share 358px. */}
          <aside
            className={[
              'min-w-0 flex-col border-[var(--jale-divider)] bg-[var(--jale-paper-2)] sm:flex sm:w-60 sm:shrink-0 sm:border-r',
              selectedKey ? 'hidden' : 'flex w-full',
            ].join(' ')}
          >
            <div className="shrink-0 border-b border-[var(--jale-divider)] bg-[var(--jale-blue-900)] p-3 text-white">
              <p className="text-sm font-bold">{t('title')}</p>
              <p className="mt-0.5 text-[11px] text-white/45">WhatsApp</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {inboxLoading ? (
                <ConversationListSkeleton label={tCommon('loading')} />
              ) : inboxErrorKind ? (
                <ErrorState kind={inboxErrorKind} onRetry={retryInbox} compact />
              ) : threads.length === 0 ? (
                <EmptyState icon="message" variant="filtered" title={t('empty')} body={t('empty_drawer_body')} />
              ) : (
                <ul className="divide-y divide-[var(--jale-divider)]">
                  {threads.map((item) => (
                    <li key={item.application_id}>
                      <DrawerThreadRow
                        item={item}
                        locale={locale}
                        selected={selectedKey === item.application_id}
                        unread={Boolean(item.conversation_id && unreadByConversation[item.conversation_id])}
                        unknownWorkerLabel={t('unknown_worker')}
                        noMessagesLabel={t('no_messages')}
                        onSelect={() => setSelectedKey(item.application_id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* Thread pane. */}
          <div
            className={[
              'min-w-0 flex-1 flex-col sm:flex',
              selectedKey ? 'flex' : 'hidden',
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

            {!selectedKey ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState icon="message" title={t('empty_select')} body={t('empty_select_body')} />
              </div>
            ) : !selectedConversationId ? (
              composerSubject ? (
                <EmptyThreadComposer
                  item={composerSubject}
                  sending={sending}
                  errorMessage={composerError}
                  onSend={handleFirstSend}
                  onBack={() => setSelectedKey(null)}
                />
              ) : inboxLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <ConversationListSkeleton label={tCommon('loading')} />
                </div>
              ) : (
                /* No thread, no inbox row, and the caller described nobody: a
                   dismissed applicant, or a row that has genuinely gone. Say so
                   rather than showing an empty thread the employer could type
                   into -- and could not address. */
                <div className="flex flex-1 items-center justify-center">
                  <EmptyState icon="message" title={t('candidate_unavailable')} body={t('empty_select_body')} />
                </div>
              )
            ) : thread.phase === 'error' && thread.errorKind ? (
              <div className="flex flex-1 items-center justify-center">
                <ErrorState kind={thread.errorKind} onRetry={thread.retry} compact />
              </div>
            ) : (
              <ConversationThread
                key={selectedConversationId}
                conversation={conversation}
                messages={messages}
                loading={thread.phase !== 'ready'}
                sending={sending}
                closing={closing}
                errorMessage={composerError}
                onSend={handleSend}
                onClose={conversation?.status === 'open' ? handleClose : undefined}
                onBack={() => setSelectedKey(null)}
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
 * The header fields of a first-message pane, from an open request -- or `null`
 * when the caller passed only ids.
 *
 * `job_title` is the gate: it is the one field whose absence would print an
 * empty line where the job belongs. A missing `applied_at` degrades quietly
 * (the composer's date formatter drops an unparseable stamp), and a missing
 * name is a legitimate value the inbox itself carries.
 */
function composerSubjectFor(target: ConversationTarget | null): ComposerSubject | null {
  if (!target || typeof target.job_title !== 'string') return null;
  return {
    worker_name: target.worker_name ?? null,
    job_title: target.job_title,
    job_city: target.job_city ?? null,
    applied_at: target.applied_at ?? '',
  };
}

/**
 * One row of the drawer's list. Extracted when the list moved onto the inbox:
 * the row now carries an unread marker as well as the four facts it always
 * had, and an unread thread is the one the employer is looking for.
 */
function DrawerThreadRow({
  item,
  locale,
  selected,
  unread,
  unknownWorkerLabel,
  noMessagesLabel,
  onSelect,
}: {
  item: InboxItem;
  locale: string;
  selected: boolean;
  unread: boolean;
  unknownWorkerLabel: string;
  noMessagesLabel: string;
  onSelect: () => void;
}) {
  const name = item.worker_name ?? unknownWorkerLabel;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={[
        'flex w-full cursor-pointer gap-2 p-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        selected ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[var(--jale-card)]',
      ].join(' ')}
    >
      <span className="avatar-initials h-8 w-8 shrink-0 text-[10px]">{initialsFor(name)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={[
              'truncate text-sm text-[var(--jale-ink)]',
              // Weight, not colour alone: the unread marker has to survive a
              // monochrome rendering and a colour-blind reader.
              unread ? 'font-extrabold' : 'font-bold',
            ].join(' ')}
          >
            {name}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--jale-ink-2)]">
            {formatTimeOfDay(item.last_message_at, locale)}
          </span>
        </span>
        <span className="block truncate text-xs text-[var(--jale-ink-2)]">
          {item.job_city ? `${item.job_title} · ${item.job_city}` : item.job_title}
        </span>
        <span className="mt-1 flex items-center gap-1.5">
          <span
            className={[
              'h-1.5 w-1.5 shrink-0 rounded-full',
              unread ? 'bg-[var(--jale-blue-700)]' : 'bg-[#25D366]',
            ].join(' ')}
          />
          <span
            className={[
              'truncate text-[11px]',
              unread ? 'font-semibold text-[var(--jale-ink)]' : 'text-[var(--jale-ink-2)]',
            ].join(' ')}
          >
            {item.last_message_preview ?? noMessagesLabel}
          </span>
        </span>
      </span>
    </button>
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
