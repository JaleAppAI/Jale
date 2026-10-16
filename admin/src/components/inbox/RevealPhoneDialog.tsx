'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { KVList } from '@/components/ui/kv-list';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import type { CaseAction } from '@/lib/server/inbox-actions';
import { useInboxActions } from './inbox-actions-context';
import { inboxActionMessage, REVEAL_REASON_MAX, REVEAL_REASON_MIN, revealReasonProblem } from './inbox-view';
import { DANGER_TEXT, LABEL, MUTED } from './styles';

/**
 * The worker's phone: hidden until an admin gives a reason (20–500
 * characters, recorded). The number lives in this component's state only,
 * so it is gone on refresh. The dialog traps focus and hands it back (Modal).
 */
export function RevealPhoneDialog({ caseId, action }: { caseId: string; action: CaseAction }) {
  const { pending, run } = useInboxActions();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = revealReasonProblem(reason);
  const reasonId = `${id}-reason`;
  const hintId = `${id}-hint`;
  const disabledId = `${id}-disabled`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== null || pending !== null) return;
    setFailure(null);
    const result = await run({ action: 'reveal_phone', caseId, justification: reason.trim() });
    if (result.ok && result.kind === 'phone') {
      setPhone(result.phone);
      setReason('');
      setOpen(false);
      return;
    }
    setFailure(inboxActionMessage('reveal_phone', result)?.text ?? null);
  }

  return (
    <div className="flex flex-col gap-2">
      <KVList items={[{ label: 'Phone', value: phone === null ? 'Hidden' : <span className="font-mono" translate="no">{phone}</span> }]} />
      <p aria-live="polite" className={MUTED} role="status">
        {phone === null ? '' : 'This reveal is recorded. The phone is hidden again when you leave this page.'}
      </p>
      <Button
        aria-describedby={action.enabled ? undefined : disabledId}
        disabled={!action.enabled || pending !== null}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        Reveal phone (logged)
      </Button>
      {action.enabled ? null : <p className={MUTED} id={disabledId}>{action.reason ?? 'Not available right now.'}</p>}
      <Modal onClose={() => setOpen(false)} open={open} size="sm" title="Reveal the phone number">
        <form className="flex flex-col gap-2" onSubmit={(event) => { void submit(event); }}>
          <label className={LABEL} htmlFor={reasonId}>Reason for revealing the phone</label>
          <Textarea
            aria-describedby={hintId}
            aria-invalid={(reason !== '' && problem !== null) || undefined}
            autoComplete="off"
            id={reasonId}
            maxLength={REVEAL_REASON_MAX}
            minLength={REVEAL_REASON_MIN}
            name="justification"
            onChange={(event) => setReason(event.target.value)}
            required
            rows={3}
            value={reason}
          />
          <p className={MUTED} id={hintId}>At least 20 characters. The reason is recorded. Do not include personal details.</p>
          {failure ? <p className={DANGER_TEXT} role="alert">{failure}</p> : null}
          <Button disabled={problem !== null || pending !== null} loading={pending === 'reveal_phone'} loadingLabel="Revealing…" type="submit" variant="error">
            Reveal phone
          </Button>
        </form>
      </Modal>
    </div>
  );
}
