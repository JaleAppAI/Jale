import type { FormEvent, Ref } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AdminRole } from '@/lib/server/admin-users';
import { ActionFeedbackNote } from './ActionFeedbackNote';
import { INVITE_NOTE, type FormFeedback } from './admin-actions';
import { RoleCards } from './RoleCards';

export type InviteFormProps = {
  email: string;
  role: AdminRole;
  busy: boolean;
  feedback?: FormFeedback;
  emailRef?: Ref<HTMLInputElement>;
  onEmailChange: (email: string) => void;
  onRoleChange: (role: AdminRole) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

/** Work email and role. After "saved, not synced" the fields lock: "Try again" resends the same invite. */
export function InviteForm({
  email, role, busy, feedback, emailRef, onEmailChange, onRoleChange, onSubmit, onCancel,
}: InviteFormProps) {
  const retrying = feedback?.retry === 'same_request';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="flex max-w-[420px] flex-col gap-1.5">
        <label className="text-sm font-semibold text-[var(--jale-ink)]" htmlFor="invite-email">Work email</label>
        <Input
          autoComplete="off"
          disabled={retrying}
          id="invite-email"
          name="email"
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="name@company.com"
          ref={emailRef}
          required
          spellCheck={false}
          type="email"
          value={email}
        />
      </div>
      <RoleCards disabled={retrying} name="invite-role" onChange={onRoleChange} value={role} />
      <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{INVITE_NOTE}</p>
      <ActionFeedbackNote feedback={feedback} />
      <div className="flex flex-wrap gap-2.5">
        <Button loading={busy} loadingLabel="Sending…" type="submit">{retrying ? 'Try again' : 'Send invite'}</Button>
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">Cancel</Button>
      </div>
    </form>
  );
}
