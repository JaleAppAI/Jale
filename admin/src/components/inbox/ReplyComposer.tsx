'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
import type { CaseAction } from '@/lib/server/inbox-actions';
import { TEMPLATE_REPLY_MAX_CHARS } from '@/lib/support-reply';
import type { SupportConversation } from '@/lib/server/support-conversation';
import { DisabledReasons } from './DisabledReasons';
import { TemplatePreview } from './TemplatePreview';
import { useInboxActions } from './inbox-actions-context';
import {
  caseAction,
  inboxActionMessage,
  replyCount,
  replyPlaceholder,
  replyProblem,
  sendLabel,
  shouldRefresh,
  TEMPLATE_NEWLINE_NOTE,
  type ActionMessage,
  type InboxActionName,
  type InboxRunResult,
  type ReplyMode,
} from './inbox-view';
import { DANGER_TEXT, LABEL, MUTED } from './styles';

export type ReplyComposerProps = {
  caseId: string;
  language: SupportConversation['language'];
  languageLabel: SupportConversation['languageLabel'];
  reply: SupportConversation['reply'];
  actions: readonly CaseAction[];
  /** No worker message yet (a case opened from a lockout): the admin writes first. */
  startsConversation: boolean;
  /** The last 30 minutes of the chat window: the server already caps replies at the template limit. */
  capSoon?: boolean;
};

export function ReplyComposer({ caseId, language, languageLabel, reply, actions, startsConversation, capSoon = false }: ReplyComposerProps) {
  const router = useRouter();
  const { pending, run } = useInboxActions();
  const id = useId();
  const [text, setText] = useState('');
  // The cap for a freeform reply sent when the window has closed or closes
  // within 30 minutes. Set when the server refuses a long reply, and implied by
  // `capSoon` (derived on every render, so a refresh that brings capSoon
  // mid-session is picked up). The view may still say freeform; the counter
  // keeps the server's limit. The refresh that follows brings the template
  // preview once the window is closed, then the server's mode wins.
  const [refusedAt, setClosedLate] = useState<number | null>(null);
  const closedLate = refusedAt ?? (capSoon ? TEMPLATE_REPLY_MAX_CHARS : null);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const [confirmingResolve, setConfirmingResolve] = useState(false);

  const lateTemplate = closedLate !== null && reply.mode === 'freeform';
  const mode: ReplyMode = lateTemplate ? 'template' : reply.mode;
  const max = lateTemplate ? closedLate : reply.maxChars;
  const count = replyCount(text, mode, max);
  const problem = replyProblem(text, mode, max);

  const replyAction = caseAction(actions, 'reply');
  const infoAction = caseAction(actions, 'request_info');
  const resolveAction = caseAction(actions, 'resolve');
  const busy = pending !== null;
  const canWrite = replyAction.enabled || infoAction.enabled;

  const textId = `${id}-text`;
  const countId = `${id}-count`;
  const noteId = `${id}-note`;
  const problemId = `${id}-problem`;
  const reasonsId = `${id}-reasons`;
  const showProblem = problem !== null && text !== '';

  function finish(action: InboxActionName, result: InboxRunResult) {
    if (!result.ok && result.error === 'reply_too_long_for_template') {
      setClosedLate(result.maxChars ?? TEMPLATE_REPLY_MAX_CHARS);
    }
    setMessage(inboxActionMessage(action, result));
    if (shouldRefresh(result)) router.refresh();
  }

  async function send(action: 'reply' | 'request_info') {
    if (busy || problem !== null) return;
    setMessage(null);
    const result = await run({ action, caseId, text: text.trim() });
    finish(action, result);
    if (result.ok) setText('');
  }

  async function resolve() {
    setMessage(null);
    const result = await run({ action: 'resolve', caseId });
    setConfirmingResolve(false);
    finish('resolve', result);
  }

  const describedBy = [countId, mode === 'template' ? noteId : null, showProblem ? problemId : null, canWrite ? null : reasonsId]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex flex-col gap-3">
      {startsConversation ? <p className={`${MUTED} font-semibold`}>Reply to start the conversation</p> : null}
      {mode === 'template' && reply.templatePreview ? <TemplatePreview preview={reply.templatePreview} text={text} /> : null}

      <div className="flex flex-col gap-1.5">
        <label className={LABEL} htmlFor={textId}>Reply ({languageLabel})</label>
        <Textarea
          aria-describedby={describedBy}
          aria-invalid={count.over || undefined}
          autoComplete="off"
          disabled={!canWrite}
          id={textId}
          name="reply"
          onChange={(event) => setText(event.target.value)}
          placeholder={replyPlaceholder(language)}
          rows={4}
          value={text}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className={count.over ? DANGER_TEXT : MUTED} id={countId}>
            <span className="tabular-nums">{count.label}</span> characters
          </span>
          {mode === 'template' ? <span className={MUTED} id={noteId}>{TEMPLATE_NEWLINE_NOTE}</span> : null}
        </div>
        {showProblem ? <p className={DANGER_TEXT} id={problemId}>{problem}</p> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap gap-2.5">
          <Button
            aria-describedby={infoAction.enabled ? undefined : reasonsId}
            disabled={!infoAction.enabled || busy || problem !== null}
            loading={pending === 'request_info'}
            loadingLabel="Sending…"
            onClick={() => { void send('request_info'); }}
            type="button"
            variant="secondary"
          >
            Ask for more info
          </Button>
          <Button
            aria-describedby={resolveAction.enabled ? undefined : reasonsId}
            disabled={!resolveAction.enabled || busy}
            onClick={() => setConfirmingResolve(true)}
            type="button"
            variant="outline"
          >
            Resolve and close
          </Button>
        </div>
        <Button
          aria-describedby={replyAction.enabled ? undefined : reasonsId}
          disabled={!replyAction.enabled || busy || problem !== null}
          loading={pending === 'reply'}
          loadingLabel="Sending…"
          onClick={() => { void send('reply'); }}
          type="button"
        >
          {sendLabel(mode)}
        </Button>
      </div>

      <DisabledReasons actions={[replyAction, infoAction, resolveAction]} id={reasonsId} />
      <p aria-live="polite" className={MUTED} role="status">{message?.tone === 'success' ? message.text : ''}</p>
      <p className={DANGER_TEXT} role="alert">{message?.tone === 'danger' ? message.text : ''}</p>

      <ConfirmDialog
        body="The worker gets the closing message on WhatsApp, and the case moves to Resolved."
        busy={pending === 'resolve'}
        confirmLabel="Resolve and close"
        onCancel={() => setConfirmingResolve(false)}
        onConfirm={() => { void resolve(); }}
        open={confirmingResolve}
        title="Resolve and send the closing message?"
      />
    </div>
  );
}
