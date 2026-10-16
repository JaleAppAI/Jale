'use client';

import { useState } from 'react';
import { SuperadminOnly } from '@/components/security/SuperadminOnly';
import { Button } from '@/components/ui/button';
import type { AdminListItem, AdminsPageResult } from '@/lib/server/admin-users';
import { ActionFeedbackNote } from './ActionFeedbackNote';
import { FOOTNOTE, type AdminActionInput, type AdminRowAction } from './admin-actions';
import { AdminsTable } from './AdminsTable';
import { ChangeRoleDialog } from './ChangeRoleDialog';
import { DeactivateDialog } from './DeactivateDialog';
import { InviteDialog } from './InviteDialog';
import { ReactivateDialog } from './ReactivateDialog';
import { useAdminAction } from './use-admin-action';

type OpenDialog =
  | { kind: 'invite' }
  | { kind: 'change_role' | 'deactivate' | 'reactivate'; admin: AdminListItem };

/** The Admins page (K1.5). The server page has already gated and recorded the read. */
export function AdminsView({ result, nowIso }: { result: AdminsPageResult; nowIso: string }) {
  if (result.status === 'forbidden') {
    return <SuperadminOnly body="Only superadmins can manage admins." title="Admins is for superadmins" />;
  }
  return <AdminsManager admins={result.admins} nowIso={nowIso} />;
}

function AdminsManager({ admins, nowIso }: { admins: AdminListItem[]; nowIso: string }) {
  const { busy, feedback, run, reset } = useAdminAction();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [lastResend, setLastResend] = useState<AdminActionInput | null>(null);

  function openDialog(next: OpenDialog) {
    reset();
    setLastResend(null);
    setDialog(next);
  }

  function closeDialog() {
    if (busy) return;
    reset();
    setDialog(null);
  }

  async function submit(input: AdminActionInput) {
    if (await run(input)) setDialog(null);
  }

  function onRowAction(action: AdminRowAction, admin: AdminListItem) {
    if (action === 'resend_invite') {
      const input: AdminActionInput = { action: 'resend_invite', adminUserId: admin.id };
      reset();
      setLastResend(input);
      void run(input);
      return;
    }
    openDialog({ kind: action, admin });
  }

  // With a dialog open its answer shows inside it; a resend answers here.
  const pageFeedback = dialog ? undefined : feedback;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--jale-ink)]">Admins</h1>
          <p className="text-sm text-[var(--jale-ink-2)]">
            Who can sign in to this console, and what they can do. Every change here is logged.
          </p>
        </div>
        <Button disabled={busy} onClick={() => openDialog({ kind: 'invite' })} type="button">Invite admin</Button>
      </header>
      {pageFeedback ? (
        <div className="flex flex-col items-start gap-2">
          <ActionFeedbackNote feedback={pageFeedback} />
          {pageFeedback.retry === 'same_request' && lastResend ? (
            <Button onClick={() => void run(lastResend)} size="sm" type="button" variant="secondary">Try again</Button>
          ) : null}
        </div>
      ) : null}
      <AdminsTable admins={admins} busy={busy} nowIso={nowIso} onAction={onRowAction} />
      <p className="text-sm text-[var(--jale-ink-2)]">{FOOTNOTE}</p>
      {dialog?.kind === 'invite' ? (
        <InviteDialog busy={busy} feedback={feedback} onClose={closeDialog} onSubmit={submit} />
      ) : null}
      {dialog?.kind === 'change_role' ? (
        <ChangeRoleDialog admin={dialog.admin} busy={busy} feedback={feedback} key={dialog.admin.id} onClose={closeDialog} onSubmit={submit} />
      ) : null}
      {dialog?.kind === 'deactivate' ? (
        <DeactivateDialog admin={dialog.admin} busy={busy} feedback={feedback} key={dialog.admin.id} onClose={closeDialog} onSubmit={submit} />
      ) : null}
      {dialog?.kind === 'reactivate' ? (
        <ReactivateDialog admin={dialog.admin} busy={busy} feedback={feedback} key={dialog.admin.id} onClose={closeDialog} onSubmit={submit} />
      ) : null}
    </div>
  );
}
