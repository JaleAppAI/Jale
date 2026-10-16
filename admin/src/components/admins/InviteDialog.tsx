'use client';

import { useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import type { AdminRole } from '@/lib/server/admin-users';
import { DEFAULT_INVITE_ROLE, inviteInput, type AdminActionInput, type FormFeedback } from './admin-actions';
import { InviteForm } from './InviteForm';

/** Mounted only while open, so each invite starts empty; focus returns to "Invite admin" on close. */
export function InviteDialog({ busy, feedback, onClose, onSubmit }: {
  busy: boolean;
  feedback?: FormFeedback;
  onClose: () => void;
  onSubmit: (input: AdminActionInput) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>(DEFAULT_INVITE_ROLE);
  const emailRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      closeOnEscape={!busy}
      closeOnOverlay={!busy}
      initialFocusRef={emailRef}
      onClose={onClose}
      open
      size="md"
      title="Invite an admin"
    >
      <InviteForm
        busy={busy}
        email={email}
        emailRef={emailRef}
        feedback={feedback}
        onCancel={onClose}
        onEmailChange={setEmail}
        onRoleChange={setRole}
        onSubmit={() => onSubmit(inviteInput(email, role))}
        role={role}
      />
    </Modal>
  );
}
