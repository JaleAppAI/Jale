'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
import { LOCKOUT_RESET_REASONS, type LockoutResetReason } from '@/lib/lockout-reasons';
import type { CaseAction } from '@/lib/server/inbox-actions';
import { useInboxActions } from './inbox-actions-context';
import { inboxActionMessage, RESET_NOTE_MAX, resetActionInput, resetFormProblem, shouldRefresh, type ActionMessage } from './inbox-view';
import { DANGER_TEXT, LABEL, MUTED, PANEL_TITLE } from './styles';

export type LockoutResetFormProps = {
  challengeId: string;
  languageLabel: string;
  attemptsAllowed: number;
  action: CaseAction;
  /** Initial selection and note, like an input's defaultValue. */
  defaultReason?: LockoutResetReason | null;
  defaultNote?: string;
};

/**
 * Reset a locked verification with a reason (K2.6/K2.7). The reasons come
 * from the client-safe lib/lockout-reasons.ts. "Other" needs a note, and a
 * confirm comes first.
 */
export function LockoutResetForm({ challengeId, languageLabel, attemptsAllowed, action, defaultReason = null, defaultNote = '' }: LockoutResetFormProps) {
  const router = useRouter();
  const { pending, run } = useInboxActions();
  const id = useId();
  const [reason, setReason] = useState<LockoutResetReason | null>(defaultReason);
  const [note, setNote] = useState(defaultNote);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const problem = resetFormProblem(reason, note);
  const canSubmit = action.enabled && problem === null && pending === null;
  const noteId = `${id}-note`;
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const disabledId = `${id}-disabled`;

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSubmit) setConfirming(true);
  }

  async function reset() {
    if (reason === null) return;
    setMessage(null);
    const result = await run(resetActionInput(challengeId, reason, note));
    setConfirming(false);
    setMessage(inboxActionMessage('reset_lockout', result));
    if (shouldRefresh(result)) router.refresh();
  }

  return (
    <form aria-labelledby={`${id}-title`} className="flex flex-col gap-3" onSubmit={ask}>
      <h2 className={PANEL_TITLE} id={`${id}-title`}>Reset verification</h2>
      <p className={MUTED}>
        Gives the worker {attemptsAllowed} new attempts and tells them on WhatsApp, in {languageLabel}. The reason is counted in Analytics.
      </p>
      <fieldset className="flex flex-col gap-1" disabled={!action.enabled}>
        <legend className={`mb-1 ${LABEL}`}>Reason</legend>
        {LOCKOUT_RESET_REASONS.map((option) => (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-[var(--jale-ink)]" key={option.code}>
            <input
              checked={reason === option.code}
              className="size-4 accent-[var(--jale-blue-500)]"
              name="reasonCode"
              onChange={() => setReason(option.code)}
              type="radio"
              value={option.code}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label className={LABEL} htmlFor={noteId}>Note</label>
        <Textarea
          aria-describedby={problem !== null && reason !== null ? `${hintId} ${problemId}` : hintId}
          aria-invalid={(reason === 'other' && note.trim() === '') || undefined}
          autoComplete="off"
          disabled={!action.enabled}
          id={noteId}
          maxLength={RESET_NOTE_MAX}
          name="note"
          onChange={(event) => setNote(event.target.value)}
          required={reason === 'other'}
          rows={3}
          value={note}
        />
        <p className={MUTED} id={hintId}>Required for Other. Up to 300 characters.</p>
        {problem !== null && reason !== null ? <p className={DANGER_TEXT} id={problemId}>{problem}</p> : null}
      </div>
      <Button
        aria-describedby={action.enabled ? undefined : disabledId}
        disabled={!canSubmit}
        loading={pending === 'reset_lockout'}
        loadingLabel="Resetting…"
        type="submit"
      >
        Reset and notify worker
      </Button>
      {action.enabled ? null : <p className={MUTED} id={disabledId}>{action.reason ?? 'Not available right now.'}</p>}
      <p aria-live="polite" className={MUTED} role="status">{message?.tone === 'success' ? message.text : ''}</p>
      <p className={DANGER_TEXT} role="alert">{message?.tone === 'danger' ? message.text : ''}</p>
      <ConfirmDialog
        body={`The worker gets ${attemptsAllowed} new attempts and a WhatsApp message in ${languageLabel}.`}
        busy={pending === 'reset_lockout'}
        confirmLabel="Reset and notify worker"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { void reset(); }}
        open={confirming}
        title="Reset and notify worker?"
      />
    </form>
  );
}
