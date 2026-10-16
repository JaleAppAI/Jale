'use client';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { AdminListItem } from '@/lib/server/admin-users';
import { ActionFeedbackNote } from './ActionFeedbackNote';
import { deactivateCopy, type AdminActionInput, type FormFeedback } from './admin-actions';

export function DeactivateDialog({ admin, busy, feedback, onClose, onSubmit }: {
  admin: AdminListItem;
  busy: boolean;
  feedback?: FormFeedback;
  onClose: () => void;
  onSubmit: (input: AdminActionInput) => void;
}) {
  const copy = deactivateCopy(admin.email);
  return (
    <ConfirmDialog
      body={(
        <div className="flex flex-col gap-3">
          <p>{copy.body}</p>
          <ActionFeedbackNote feedback={feedback} />
        </div>
      )}
      busy={busy}
      confirmLabel={feedback?.retry === 'same_request' ? 'Try again' : copy.confirmLabel}
      onCancel={onClose}
      onConfirm={() => onSubmit({ action: 'deactivate', adminUserId: admin.id })}
      open
      title={copy.title}
      tone="error"
    />
  );
}
