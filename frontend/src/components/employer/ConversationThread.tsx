'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';
import { Skeleton, SkeletonCircle, SkeletonLine } from '@/components/ui/skeleton';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { classifyError } from '@/lib/api/errors';
import type {
  EmployerConversationDetail,
  EmployerConversationMessage,
} from '@/lib/api/employer';

/**
 * The WhatsApp transcript pane, shared by the conversations page and the global
 * drawer so both surfaces speak the same language about failure.
 *
 * THE MUTATION CONTRACT (both callers implement it identically):
 *
 *  - `onSend` MUST reject when the send failed. This component clears the
 *    composer only after it RESOLVES, so a rejection is what preserves the text
 *    the user typed. The rejection is caught here -- it is the caller's own
 *    handler that reports it, through `errorMessage`, into the slot above the
 *    composer. Nothing about the transcript changes.
 *  - `onClose` MUST reject when the close failed. The confirmation dialog below
 *    stays open and shows why, so the user can retry from where they are
 *    instead of re-opening the dialog against an unexplained no-op.
 *
 * Before this contract existed, `handleSubmit` awaited `onSend` with no catch:
 * a rejected send cleared nothing but surfaced as an unhandled promise
 * rejection, and the drawer had to re-throw from its own catch block to stop
 * the draft being wiped. Now the rule is stated once, here.
 */

type Props = {
  conversation: EmployerConversationDetail | null;
  messages: EmployerConversationMessage[];
  /** The thread itself is being (re)fetched and there is nothing to show yet. */
  loading?: boolean;
  sending?: boolean;
  closing?: boolean;
  /** Send failure, rendered against the composer. Owned by the caller. */
  errorMessage?: string | null;
  /** Rejects on failure -- see the mutation contract above. */
  onSend: (body: string) => Promise<void>;
  /** Rejects on failure. Presence also gates the Close control. */
  onClose?: () => Promise<void>;
  onDismiss?: () => void;
  /** Small-screen "back to the list" affordance. Desktop keeps both panes. */
  onBack?: () => void;
  /**
   * Width at which the caller's list pane reappears, so the back button can
   * hide exactly there. The board collapses at `xl`; the drawer, being much
   * narrower, collapses at `sm`. Literal classes (not interpolated) so
   * Tailwind's scanner can see both.
   */
  backHiddenFrom?: 'sm' | 'xl';
  compact?: boolean;
};

const backHiddenClasses = { sm: 'sm:hidden', xl: 'xl:hidden' } as const;

export function ConversationThread({
  conversation,
  messages,
  loading = false,
  sending = false,
  closing = false,
  errorMessage = null,
  onSend,
  onClose,
  onDismiss,
  onBack,
  backHiddenFrom = 'xl',
  compact = false,
}: Props) {
  const t = useTranslations('employer_messages');
  const tCommon = useTranslations('common');
  const translateError = useErrorMessage();
  const [body, setBody] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // A destructive dialog opens on its SAFE action rather than on the header's
  // dismiss button, which is what Modal picks by default.
  const closeCancelRef = useRef<HTMLButtonElement>(null);

  // Both surfaces can be mounted at once (the drawer floats over the page), so
  // a hardcoded id would collide and point the textarea at the wrong message.
  const errorId = useId();

  // Called before the early returns below so the hook order never changes.
  const transcript = useStickToBottom(messages.length);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || sending || !conversation || conversation.status === 'closed') return;
    try {
      await onSend(trimmed);
      setBody('');
    } catch {
      // Deliberately swallowed: the caller already reported this through
      // `errorMessage`. Catching is what keeps the draft in the box and keeps a
      // failed send from becoming an unhandled rejection in the console.
    }
  }

  async function handleConfirmClose() {
    if (!onClose) return;
    setCloseError(null);
    try {
      await onClose();
      setConfirmingClose(false);
    } catch (err) {
      // The legal wall is a redirect already in flight, not a sentence the user
      // can act on -- showing generic copy under it would just flash.
      if (classifyError(err).kind === 'legal_wall') return;
      setCloseError(translateError(err));
    }
  }

  if (loading) return <ThreadPaneSkeleton label={tCommon('loading')} compact={compact} />;

  if (!conversation) {
    return (
      <section className="flex min-h-[420px] flex-1 items-center justify-center bg-[var(--jale-card)]">
        <EmptyState icon="message" title={t('empty_select')} body={t('empty_select_body')} />
      </section>
    );
  }

  const workerName = conversation.worker_name ?? t('unknown_worker');
  const initials = initialsFor(workerName);
  const isOpen = conversation.status === 'open';
  const lastMessage = messages[messages.length - 1];

  return (
    <section className="anim-fade-in flex min-h-[420px] flex-1 flex-col overflow-hidden bg-[var(--jale-card)]">
      <header className="shrink-0 border-b border-[var(--jale-divider)] px-4 py-3">
        {/* Wraps rather than squeezes. On a 390px phone the two actions and the
            worker's name cannot share one line, and a name truncated to zero
            characters is worse than a second row. `basis` is the width the
            identity block refuses to go below before the actions drop under it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label={t('back_to_list')}
                className={`-ml-1 shrink-0 cursor-pointer rounded p-1.5 leading-none text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] ${backHiddenClasses[backHiddenFrom]}`}
              >
                <BackArrow />
              </button>
            ) : null}

            <span className="avatar-initials h-10 w-10 shrink-0 text-xs">{initials}</span>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2">
                <h2 className="truncate text-sm font-bold text-[var(--jale-ink)]">{workerName}</h2>
                <StatusDot open={isOpen} label={isOpen ? t('status_open') : t('status_closed')} />
              </div>
              <p className="truncate text-[11px] font-medium text-[var(--jale-ink-2)]">
                WhatsApp - {conversation.job_title}
              </p>
              {!compact && lastMessage ? (
                <p className="mt-0.5 text-[10px] tabular-nums text-[var(--jale-ink-2)]">
                  {formatMessageTime(lastMessage.created_at)}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {onDismiss ? (
              <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
                {t('not_interested')}
              </Button>
            ) : null}
            {onClose && isOpen ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCloseError(null);
                  setConfirmingClose(true);
                }}
              >
                {t('close')}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div
        ref={transcript.ref}
        onScroll={transcript.onScroll}
        className="flex-1 space-y-3 overflow-y-auto bg-[var(--jale-paper-2)] p-4"
      >
        {messages.length === 0 ? (
          <EmptyState icon="message" variant="filtered" title={t('no_messages')} body={t('subtitle')} />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              initials={initials}
              statusLabel={
                message.sender_type === 'employer'
                  ? t(`message_status.${message.status}`)
                  : t('from_worker')
              }
            />
          ))
        )}
      </div>

      <form onSubmit={handleSubmit} className="shrink-0 border-t border-[var(--jale-divider)] p-3">
        {errorMessage ? (
          <p id={errorId} role="alert" className="mb-2 text-xs font-medium text-[var(--jale-danger-text)]">
            {errorMessage}
          </p>
        ) : null}

        {conversation.status === 'closed' ? (
          <p className="text-sm text-[var(--jale-ink-2)]">{t('closed_hint')}</p>
        ) : (
          <div className="flex gap-2">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={2000}
              rows={compact ? 1 : 2}
              placeholder={t('composer_placeholder')}
              aria-describedby={errorMessage ? errorId : undefined}
              aria-invalid={errorMessage ? true : undefined}
              className="min-h-[42px] flex-1 resize-none rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-3 py-2 text-sm text-[var(--jale-ink)] outline-none placeholder:text-[var(--jale-ink-2)] focus:border-[var(--primary)] focus:bg-[var(--jale-card)]"
            />
            <Button type="submit" loading={sending} loadingLabel={tCommon('loading')} disabled={!body.trim()}>
              {t('send')}
            </Button>
          </div>
        )}
      </form>

      <Modal
        open={confirmingClose}
        onClose={() => setConfirmingClose(false)}
        title={t('close_confirm_title')}
        size="sm"
        initialFocusRef={closeCancelRef}
        footer={
          <>
            <Button ref={closeCancelRef} type="button" variant="ghost" onClick={() => setConfirmingClose(false)} disabled={closing}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="error"
              onClick={handleConfirmClose}
              loading={closing}
              loadingLabel={tCommon('loading')}
            >
              {t('close_confirm_cta')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--jale-ink-2)]">{t('close_confirm_body')}</p>
        {closeError ? (
          <InlineFeedback tone="danger" className="mt-3">
            {closeError}
          </InlineFeedback>
        ) : null}
      </Modal>
    </section>
  );
}

/**
 * One transcript bubble. Soft 14px corners with a 4px anchor on the corner
 * nearest its sender, so the direction of a message is readable from shape
 * alone -- colour is the secondary cue, not the only one.
 */
function MessageBubble({
  message,
  initials,
  statusLabel,
}: {
  message: EmployerConversationMessage;
  initials: string;
  statusLabel: string;
}) {
  const mine = message.sender_type === 'employer';

  return (
    <div className={`flex gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
      {!mine ? (
        <span className="avatar-initials mt-1 h-7 w-7 shrink-0 text-[10px]">{initials}</span>
      ) : null}

      <div className={`max-w-[82%] ${mine ? 'text-right' : 'text-left'}`}>
        <div
          className={[
            'inline-block px-3 py-2 text-sm leading-relaxed shadow-[var(--shadow-card)]',
            mine
              ? 'rounded-[14px_4px_14px_14px] bg-[var(--primary)] text-white'
              : 'rounded-[4px_14px_14px_14px] border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]',
          ].join(' ')}
        >
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>
        <p className="mt-1 text-[10px] tabular-nums text-[var(--jale-ink-2)]">
          {statusLabel}
          {' - '}
          {formatMessageTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}

/**
 * Status as a dot plus its word. The dot alone would carry the meaning in
 * colour only; the word is what makes it readable to everyone, and it keeps the
 * header free of another pill competing with the worker's name.
 *
 * `#25D366` is WhatsApp's brand green -- the single sanctioned literal in this
 * app, kept identical in both themes because a brand colour that re-tints stops
 * being the brand colour.
 */
function StatusDot({ open, label }: { open: boolean; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--jale-ink-2)]">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${open ? 'bg-[#25D366]' : 'bg-[var(--jale-ink-2)]'}`}
      />
      {label}
    </span>
  );
}

/**
 * In-pane placeholder for "switching to another thread". Traced from the real
 * header/transcript/composer rhythm above so the swap costs no layout shift.
 * The whole-page first load uses `ThreadSkeleton` instead.
 */
function ThreadPaneSkeleton({ label, compact }: { label: string; compact: boolean }) {
  return (
    <section role="status" className="flex min-h-[420px] flex-1 flex-col bg-[var(--jale-card)]">
      <span className="sr-only">{label}</span>

      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--jale-divider)] px-4 py-3">
        <SkeletonCircle size={40} />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonLine width="w-40" />
          <SkeletonLine width="w-24" tone="paper" />
        </div>
      </div>

      <div className="flex-1 space-y-3 bg-[var(--jale-paper-2)] p-4">
        {Array.from({ length: compact ? 4 : 6 }).map((_, i) => {
          const inbound = i % 2 === 0;
          return (
            <div key={i} className={inbound ? 'flex justify-start' : 'flex justify-end'}>
              <Skeleton
                tone={inbound ? 'divider' : 'paper'}
                className={`h-12 ${inbound ? 'w-3/5 rounded-[4px_14px_14px_14px]' : 'w-1/2 rounded-[14px_4px_14px_14px]'}`}
              />
            </div>
          );
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--jale-divider)] p-3">
        <Skeleton className="h-11 w-full rounded-[var(--radius-input)]" />
      </div>
    </section>
  );
}

function BackArrow() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/**
 * Shared by the board, the drawer and the first-message composer so one worker
 * is never "MG" in one pane and "M" in another.
 */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

export function formatMessageTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Keeps the newest message in view without stealing the scroll position from
 * someone reading back through the history: it only follows when the transcript
 * grew AND the user was already parked at the bottom.
 *
 * Exported for the two panes that render transcripts; kept here so the rule
 * lives next to the markup it scrolls.
 */
export function useStickToBottom(dependency: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const previousRef = useRef(dependency);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const grew = dependency > previousRef.current;
    previousRef.current = dependency;
    if (!grew || !wasAtBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [dependency]);

  return {
    ref,
    onScroll: () => {
      const node = ref.current;
      if (!node) return;
      wasAtBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    },
  };
}
