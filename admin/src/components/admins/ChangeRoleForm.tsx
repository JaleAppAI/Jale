import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import type { AdminRole } from '@/lib/server/admin-users';
import { ActionFeedbackNote } from './ActionFeedbackNote';
import { CHANGE_ROLE_NOTE, type FormFeedback } from './admin-actions';
import { RoleCards } from './RoleCards';

export type ChangeRoleFormProps = {
  currentRole: AdminRole;
  role: AdminRole;
  busy: boolean;
  feedback?: FormFeedback;
  onRoleChange: (role: AdminRole) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

export function ChangeRoleForm({
  currentRole, role, busy, feedback, onRoleChange, onSubmit, onCancel,
}: ChangeRoleFormProps) {
  const retrying = feedback?.retry === 'same_request';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <RoleCards disabled={retrying} name="change-role" onChange={onRoleChange} value={role} />
      <p className="text-sm leading-relaxed text-[var(--jale-ink-2)]">{CHANGE_ROLE_NOTE}</p>
      <ActionFeedbackNote feedback={feedback} />
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={role === currentRole && !retrying} loading={busy} loadingLabel="Saving…" type="submit">
          {retrying ? 'Try again' : 'Save role'}
        </Button>
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">Cancel</Button>
      </div>
    </form>
  );
}
