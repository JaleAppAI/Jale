'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import type { AdminListItem, AdminRole } from '@/lib/server/admin-users';
import { changeRoleTitle, type AdminActionInput, type FormFeedback } from './admin-actions';
import { ChangeRoleForm } from './ChangeRoleForm';

export function ChangeRoleDialog({ admin, busy, feedback, onClose, onSubmit }: {
  admin: AdminListItem;
  busy: boolean;
  feedback?: FormFeedback;
  onClose: () => void;
  onSubmit: (input: AdminActionInput) => void;
}) {
  const [role, setRole] = useState<AdminRole>(admin.role);
  return (
    <Modal
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      onClose={onClose}
      open
      size="md"
      title={<span className="[overflow-wrap:anywhere]">{changeRoleTitle(admin.email)}</span>}
    >
      <ChangeRoleForm
        busy={busy}
        currentRole={admin.role}
        feedback={feedback}
        onCancel={onClose}
        onRoleChange={setRole}
        onSubmit={() => onSubmit({ action: 'change_role', adminUserId: admin.id, role })}
        role={role}
      />
    </Modal>
  );
}
