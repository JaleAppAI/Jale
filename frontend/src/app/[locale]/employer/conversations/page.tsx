'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from '@/i18n/navigation';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { MetricCard } from '@/components/ui/metric-card';
import { Modal } from '@/components/ui/modal';
import { ThreadSkeleton } from '@/components/ui/page-skeletons';
import { useToast } from '@/components/ui/toast';
import {
  ConversationThread,
  formatMessageTime,
  initialsFor,
} from '@/components/employer/ConversationThread';
import { EmptyThreadComposer } from '@/components/employer/EmptyThreadComposer';
import { isLegalWallError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
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
  EmployerConversationResponse,
  EmployerInboxResponse,
  InboxItem,
  InboxTab,
} from '@/lib/api/employer';

/**
 * The employer conversations board.
 *
 * Two independent `usePageData` lifecycles drive it, and that split is the
 * point: the inbox and the open thread fail, load and refresh separately, so
 * neither can take the other down.
 *
 * The bug this structure retires: the thread used to be polled by a hand-rolled
 * `setInterval` whose catch wrote a page-level `error`, which the render
 * branched on FIRST. One dropped poll -- a tunnel, a sleeping laptop, a 502 --
 * replaced the entire board, including the messages already on screen, with a
 * single line of red text. `usePageData` makes that unreachable rather than
 * unlikely: a failed background refresh can only ever set `refreshError`; it is
 * structurally incapable of touching `phase` or `data`. So a failed poll is now
 * a dismissible banner over an intact transcript.
 */

const RETURN_URL = '/employer/conversations';
const THREAD_POLL_MS = 15000;

function visibleItemsOf(items: InboxItem[], tab: InboxTab, jobFilter: string | null): InboxItem[] {
  return items.filter((item) => item.tab === tab && (!jobFilter || item.job_id === jobFilter));
}

export default function EmployerConversationsPage() {
  const searchParams = useSearchParams();
  const { idToken } = useAuth();
  const router = useRouter();
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const translateError = useErrorMessage();
  const toast = useToast();

  const [tab, setTab] = useState<InboxTab>('active');
  const [jobFilter, setJobFilter] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  /** Send/start failure, rendered in the composer's error slot. */
  const [composerError, setComposerError] = useState<string | null>(null);
  const [pollNoticeDismissed, setPollNoticeDismissed] = useState(false);

  const [dismissTarget, setDismissTarget] = useState<InboxItem | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  /**
   * Mutations do their own legal-wall routing: `usePageData` only owns the
   * fetches. Returns true when it handled the error, so callers can skip
   * showing copy under a redirect that is already in flight.
   */
  const routeLegalWall = useCallback(
    (err: unknown): boolean => {
      if (!isLegalWallError(err)) return false;
      sessionStorage.setItem('legalReturnUrl', RETURN_URL);
      router.replace('/legal/accept');
      return true;
    },
    [router],
  );

  const inbox = usePageData<EmployerInboxResponse>({
    fetcher: ({ token }) => getInbox(token),
    legalReturnUrl: RETURN_URL,
    isEmpty: (data) => visibleItemsOf(data.items, tab, jobFilter).length === 0,
  });

  const { data: inboxData, setData: setInboxData, refresh: refreshInbox } = inbox;

  const items = useMemo(() => inboxData?.items ?? [], [inboxData]);
  const jobs = inboxData?.jobs ?? [];
  const visibleItems = useMemo(
    () => visibleItemsOf(items, tab, jobFilter),
    [items, tab, jobFilter],
  );

  const selectedItem = items.find((item) => item.application_id === selectedKey) ?? null;
  const selectedConversationId = selectedItem?.conversation_id ?? null;

  /**
   * The thread is a SEPARATE lifecycle keyed on the selected conversation:
   * switching threads resets it (skeleton, then load) and aborts the previous
   * request, and only this instance polls.
   *
   * With nothing selected the fetcher resolves `null` rather than firing a
   * request for an id that does not exist -- a legitimate "there is no thread",
   * not a swallowed failure. Polling is switched off in that state too.
   */
  const thread = usePageData<EmployerConversationResponse | null>({
    fetcher: ({ token }) =>
      selectedConversationId ? getConversation(token, selectedConversationId) : Promise.resolve(null),
    legalReturnUrl: RETURN_URL,
    deps: [selectedConversationId],
    pollMs: selectedConversationId ? THREAD_POLL_MS : undefined,
  });

  const { setData: setThreadData, refresh: refreshThread, refreshError: threadRefreshError } = thread;

  const conversation = thread.data?.conversation ?? null;
  const messages = useMemo(() => thread.data?.messages ?? [], [thread.data]);

  // A deep link picks the thread once, on the first inbox that can resolve it.
  // Ref-guarded so it never fights the user's later selections.
  const deepLinkId = searchParams.get('conversation_id');
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current || !deepLinkId || !inboxData) return;
    deepLinkAppliedRef.current = true;
    const target = inboxData.items.find((item) => item.conversation_id === deepLinkId);
    if (!target) return;
    setTab(target.tab);
    setJobFilter(null);
    setSelectedKey(target.application_id);
  }, [inboxData, deepLinkId]);

  // A row that vanished (dismissed elsewhere, or gone on reload) must not leave
  // the board pointing at a thread the user can no longer reach from the list.
  useEffect(() => {
    if (!selectedKey || !inboxData) return;
    if (inboxData.items.some((item) => item.application_id === selectedKey)) return;
    setSelectedKey(null);
  }, [inboxData, selectedKey]);

  // A composer error belongs to the thread it was raised in.
  useEffect(() => {
    setComposerError(null);
  }, [selectedConversationId]);

  // Re-arm the poll banner once a refresh succeeds, so dismissing it silences
  // only THIS outage rather than every future one.
  useEffect(() => {
    if (threadRefreshError === null) setPollNoticeDismissed(false);
  }, [threadRefreshError]);

  function applyConversationToItems(detail: EmployerConversationDetail, applicationId: string) {
    setInboxData((prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.application_id === applicationId
          ? {
              ...item,
              conversation_id: detail.id,
              conversation_status: detail.status,
              last_message_at: detail.last_message_at,
              last_worker_message_at: detail.last_worker_message_at,
              last_message_preview: detail.last_message_preview,
              application_status:
                item.application_status === 'pending' ? 'contacted' : item.application_status,
            }
          : item,
      ),
    }));
  }

  async function handleSend(body: string) {
    if (!idToken || !selectedItem || !selectedConversationId) return;
    setSending(true);
    setComposerError(null);
    try {
      const detail = await sendConversationMessage(idToken, selectedConversationId, body);
      setThreadData(detail);
      applyConversationToItems(detail.conversation, selectedItem.application_id);
    } catch (err) {
      if (!routeLegalWall(err)) setComposerError(translateError(err));
      // Re-raised on purpose: `ConversationThread` clears the composer only when
      // this resolves, so the rejection is what preserves the user's draft. The
      // line above is the visible half; this is the useful half.
      throw err;
    } finally {
      setSending(false);
    }
  }

  async function handleFirstSend(body: string) {
    if (!idToken || !selectedItem) return;
    setSending(true);
    setComposerError(null);
    try {
      const detail = await startConversation(idToken, {
        job_id: selectedItem.job_id,
        worker_id: selectedItem.worker_id,
        initial_message: body,
      });
      // Filling in `conversation_id` moves this row from "new applicant" to a
      // real thread, which changes the thread instance's deps and makes it load
      // the conversation that now exists.
      applyConversationToItems(detail.conversation, selectedItem.application_id);
    } catch (err) {
      if (!routeLegalWall(err)) {
        // These two are specific enough to deserve their own sentence; the
        // generic classifier would flatten both into "check your input".
        const code = err instanceof ApiError ? err.code : null;
        if (code === 'worker_whatsapp_unavailable') {
          setComposerError(t('worker_whatsapp_unavailable'));
        } else if (code === 'applicant_not_found') {
          setComposerError(t('candidate_unavailable'));
          void refreshInbox();
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
    if (!idToken || !selectedItem || !selectedConversationId) return;
    setClosing(true);
    try {
      const detail = await closeConversation(idToken, selectedConversationId);
      setThreadData(detail);
      applyConversationToItems(detail.conversation, selectedItem.application_id);
      // Closing moves the row between tabs; the server owns that rule, so ask
      // it rather than guessing here.
      void refreshInbox();
      toast.success(t('conversation_closed'));
    } catch (err) {
      routeLegalWall(err);
      // Rejected so the confirmation dialog stays open and says why.
      throw err;
    } finally {
      setClosing(false);
    }
  }

  async function handleDismissConfirm() {
    const target = dismissTarget;
    if (!idToken || !target) return;
    setDismissing(true);
    setDismissError(null);
    try {
      await updateApplicantStatus(idToken, target.job_id, target.worker_id, 'not_interested');
      setInboxData((prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.application_id !== target.application_id),
      }));
      if (selectedKey === target.application_id) setSelectedKey(null);
      setDismissTarget(null);
      toast.success(t('candidate_removed'));
    } catch (err) {
      if (!routeLegalWall(err)) setDismissError(translateError(err));
    } finally {
      setDismissing(false);
    }
  }

  function switchTab(next: InboxTab) {
    setTab(next);
    setJobFilter(null);
    setSelectedKey((current) => {
      const stillVisible = items.some(
        (item) => item.application_id === current && item.tab === next,
      );
      return stillVisible ? current : null;
    });
  }

  const activeItems = items.filter((item) => item.tab === 'active');
  const newApplicantCount = activeItems.filter((item) => !item.conversation_id).length;
  const repliedCount = activeItems.filter(
    (item) => item.conversation_id && item.last_worker_message_at,
  ).length;
  const waitingCount = activeItems.filter(
    (item) => item.conversation_id && !item.last_worker_message_at,
  ).length;

  const shell = (children: ReactNode) => (
    <AppShell role="employer" title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-7xl px-4 py-6">{children}</div>
    </AppShell>
  );

  // S1 -- nothing has arrived yet. Same archetype as the route's loading.tsx, so
  // a server-rendered navigation and a client-side one look identical.
  if (inbox.phase === 'auth' || inbox.phase === 'loading') {
    return shell(<ThreadSkeleton />);
  }

  // S5 -- the inbox itself failed with nothing to fall back on. `ErrorState`
  // picks the copy, the icon, and whether retrying is even honest, from the kind.
  if (inbox.phase === 'error' && inbox.errorKind) {
    return shell(
      <div className="anim-fade-in overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)]">
        <ErrorState kind={inbox.errorKind} onRetry={inbox.retry} backHref="/employer/dashboard" />
      </div>,
    );
  }

  const threadPaneOpen = selectedKey !== null;

  return shell(
    <>
      <section className="anim-fade-in mb-5 grid gap-3 md:grid-cols-4">
        <MetricCard variant="accent" tone="blue" value={activeItems.length} label={t('candidates')} hint={t('subtitle')} />
        <MetricCard variant="accent" tone="green" value={repliedCount} label={t('worker_replied')} hint={t('reply_window_open')} />
        <MetricCard variant="accent" tone="amber" value={waitingCount} label={t('waiting_reply')} hint={t('template_invite_sent')} />
        <MetricCard variant="accent" tone="navy" value={newApplicantCount} label={t('new_applicants')} hint={t('not_yet_messaged')} />
      </section>

      {/* One bordered container; every pane inside it is separated by dividers,
          never by its own border or its own background card. */}
      <section className="anim-fade-in grid min-h-[680px] overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-[var(--jale-card)] shadow-[var(--shadow-card)] xl:grid-cols-[320px_minmax(0,1fr)_280px]">
        {/* Pane 1 -- inbox. Below xl it is the WHOLE screen until a thread is
            picked, and then it steps aside for the thread (which grows a back
            button). A 320px list and a transcript cannot share a phone. */}
        <aside
          className={[
            'min-w-0 border-[var(--jale-divider)] xl:block xl:border-b-0 xl:border-r',
            threadPaneOpen ? 'hidden' : 'block border-b',
          ].join(' ')}
        >
          <div className="border-b border-[var(--jale-divider)] px-4 py-3">
            <div className="flex rounded-[var(--radius-input)] bg-[var(--jale-paper-2)] p-1">
              {(['active', 'closed'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchTab(value)}
                  aria-pressed={tab === value}
                  className={[
                    'flex-1 cursor-pointer rounded-[calc(var(--radius-input)-2px)] px-3 py-1.5 text-xs font-bold transition-colors',
                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                    tab === value
                      ? 'bg-[var(--jale-card)] text-[var(--jale-ink)] shadow-[var(--shadow-btn)]'
                      : 'text-[var(--jale-ink-2)] hover:text-[var(--jale-ink)]',
                  ].join(' ')}
                >
                  {value === 'active' ? t('tab_active') : t('tab_closed')}
                </button>
              ))}
            </div>

            {jobs.length > 1 ? (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                <FilterChip active={jobFilter === null} onClick={() => setJobFilter(null)}>
                  {t('all_jobs')}
                </FilterChip>
                {jobs.map((job) => (
                  <FilterChip
                    key={job.job_id}
                    active={jobFilter === job.job_id}
                    onClick={() => setJobFilter((current) => (current === job.job_id ? null : job.job_id))}
                  >
                    {job.title}
                  </FilterChip>
                ))}
              </div>
            ) : null}
          </div>

          {/* S3 -- empty, and the copy says WHICH empty: this tab, or this filter. */}
          {visibleItems.length === 0 ? (
            jobFilter ? (
              <EmptyState
                variant="filtered"
                title={t('empty_filtered_title')}
                body={t('empty_filtered_body')}
                action={{ label: t('clear_job_filter'), onClick: () => setJobFilter(null) }}
              />
            ) : (
              <EmptyState
                icon="message"
                variant="filtered"
                title={tab === 'active' ? t('empty_tab_active_title') : t('empty_tab_closed_title')}
                body={tab === 'active' ? t('empty_tab_active') : t('empty_tab_closed')}
              />
            )
          ) : (
            <ul className="max-h-[300px] divide-y divide-[var(--jale-divider)] overflow-y-auto xl:max-h-[560px]">
              {visibleItems.map((item) => (
                <li key={item.application_id}>
                  <InboxRow
                    item={item}
                    selected={selectedKey === item.application_id}
                    onSelect={() => setSelectedKey(item.application_id)}
                    unknownWorkerLabel={t('unknown_worker')}
                    newApplicantLabel={t('new_applicant')}
                    statusLabel={item.conversation_status === 'closed' ? t('status_closed') : t('status_open')}
                    noMessagesLabel={t('no_messages')}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Pane 2 -- the thread. */}
        <div
          className={[
            'min-w-0 flex-col border-[var(--jale-divider)] xl:flex xl:border-b-0 xl:border-r',
            threadPaneOpen ? 'flex border-b' : 'hidden',
          ].join(' ')}
        >
          {/* S6 -- a poll tick failed. The transcript below is untouched and
              still the last known good one; this is a footnote, not a page state. */}
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

          {!selectedItem ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon="message" title={t('empty_select')} body={t('empty_select_body')} />
            </div>
          ) : !selectedConversationId ? (
            <EmptyThreadComposer
              item={selectedItem}
              sending={sending}
              errorMessage={composerError}
              onSend={handleFirstSend}
              onDismiss={() => {
                setDismissError(null);
                setDismissTarget(selectedItem);
              }}
              onBack={() => setSelectedKey(null)}
            />
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
              onDismiss={() => {
                setDismissError(null);
                setDismissTarget(selectedItem);
              }}
              onBack={() => setSelectedKey(null)}
            />
          )}
        </div>

        {/* Pane 3 -- status rail. Desktop only; on a phone the thread header
            already carries the same facts. */}
        <aside className="hidden min-w-0 xl:block">
          <div className="border-b border-[var(--jale-divider)] px-4 py-3">
            <p className="text-sm font-bold text-[var(--jale-ink)]">{t('thread_status')}</p>
            <p className="text-[11px] text-[var(--jale-ink-2)]">{t('current_handoff')}</p>
          </div>

          {selectedItem ? (
            <div className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <span className="avatar-initials h-12 w-12 shrink-0 text-sm">
                  {initialsFor(selectedItem.worker_name ?? t('unknown_worker'))}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--jale-ink)]">
                    {selectedItem.worker_name ?? t('unknown_worker')}
                  </p>
                  <p className="truncate text-xs text-[var(--jale-ink-2)]">{selectedItem.job_title}</p>
                </div>
              </div>

              {selectedItem.conversation_id ? (
                <>
                  <StatusRow
                    label={t('conversation')}
                    value={selectedItem.conversation_status === 'open' ? t('status_open') : t('status_closed')}
                    tone={selectedItem.conversation_status === 'open' ? 'live' : 'idle'}
                  />
                  <StatusRow
                    label={t('worker_reply')}
                    value={selectedItem.last_worker_message_at ? t('received') : t('waiting')}
                    tone={selectedItem.last_worker_message_at ? 'live' : 'pending'}
                  />
                </>
              ) : (
                <StatusRow label={t('conversation')} value={t('new_applicant')} tone="info" />
              )}

              <StatusRow label={t('channel')} value="WhatsApp" tone="info" />

              <div className="rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                  {t('latest_message')}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-[var(--jale-ink)]">
                  {selectedItem.last_message_preview ?? t('no_messages')}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState icon="user" variant="filtered" title={t('empty_select')} />
          )}
        </aside>
      </section>

      {/* S7 -- destructive confirmation. This replaced a native browser confirm
          dialog, which could not be themed, could not be trapped for focus, and
          had nowhere to put the failure when the request behind it went wrong. */}
      <Modal
        open={dismissTarget !== null}
        onClose={() => setDismissTarget(null)}
        title={t('dismiss_confirm_title')}
        size="sm"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setDismissTarget(null)} disabled={dismissing}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="error"
              onClick={handleDismissConfirm}
              loading={dismissing}
              loadingLabel={tCommon('loading')}
            >
              {t('not_interested')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--jale-ink-2)]">{t('not_interested_confirm')}</p>
        {dismissError ? (
          <InlineFeedback tone="danger" className="mt-3">
            {dismissError}
          </InlineFeedback>
        ) : null}
      </Modal>
    </>,
  );
}

/** One divided inbox row: avatar, name, job, status dot + word, timestamp. */
function InboxRow({
  item,
  selected,
  onSelect,
  unknownWorkerLabel,
  newApplicantLabel,
  statusLabel,
  noMessagesLabel,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: () => void;
  unknownWorkerLabel: string;
  newApplicantLabel: string;
  statusLabel: string;
  noMessagesLabel: string;
}) {
  const name = item.worker_name ?? unknownWorkerLabel;
  const started = Boolean(item.conversation_id);
  const open = item.conversation_status === 'open';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={[
        'flex w-full cursor-pointer gap-3 px-4 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        selected ? 'bg-[var(--jale-blue-50)]' : 'hover:bg-[var(--jale-paper-2)]',
      ].join(' ')}
    >
      <span className="avatar-initials h-9 w-9 shrink-0 text-[11px]">{initialsFor(name)}</span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-bold text-[var(--jale-ink)]">{name}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--jale-ink-2)]">
            {formatMessageTime(item.last_message_at ?? item.applied_at)}
          </span>
        </span>

        <span className="mt-0.5 block truncate text-[11px] text-[var(--jale-ink-2)]">{item.job_title}</span>

        <span className="mt-1 flex items-center gap-1.5">
          {/* `#25D366` is WhatsApp's brand green -- the one sanctioned literal,
              identical in both themes. Everything else here is a token. */}
          <span
            className={[
              'h-1.5 w-1.5 shrink-0 rounded-full',
              !started ? 'bg-[var(--jale-blue-700)]' : open ? 'bg-[#25D366]' : 'bg-[var(--jale-ink-2)]',
            ].join(' ')}
          />
          <span className="shrink-0 text-[11px] font-semibold text-[var(--jale-ink-2)]">
            {started ? statusLabel : newApplicantLabel}
          </span>
          {started ? (
            <span className="truncate text-[11px] text-[var(--jale-ink-2)]">
              {'·'} {item.last_message_preview ?? noMessagesLabel}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'max-w-[160px] shrink-0 cursor-pointer truncate rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        active
          ? 'border-[var(--primary)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
          : 'border-[var(--jale-divider)] text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** Label + dot-and-word value. No pills: the rail is a list of facts, not chips. */
function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'live' | 'pending' | 'idle' | 'info';
}) {
  const dotClass = {
    live: 'bg-[#25D366]',
    pending: 'bg-[var(--jale-warning)]',
    idle: 'bg-[var(--jale-ink-2)]',
    info: 'bg-[var(--jale-blue-700)]',
  }[tone];

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold text-[var(--jale-ink-2)]">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
        <span className="truncate text-xs font-bold text-[var(--jale-ink)]">{value}</span>
      </span>
    </div>
  );
}
