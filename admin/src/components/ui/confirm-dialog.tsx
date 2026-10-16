'use client';

import { useRef, type ReactNode } from 'react';
import { Button } from './button';
import { Modal } from './modal';

/**
 * A yes/no dialog on `Modal`. Opens on Cancel (the safe choice), cannot be
 * dismissed while `busy`, and `Modal` returns focus to the opener on close.
 */
export function ConfirmDialog({
    open,
    title,
    body,
    confirmLabel,
    cancelLabel = 'Cancel',
    tone = 'primary',
    busy = false,
    onConfirm,
    onCancel,
}: {
    open: boolean;
    title: string;
    body: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: 'primary' | 'error';
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const close = () => {
        if (!busy) onCancel();
    };

    return (
        <Modal
            open={open}
            onClose={close}
            title={title}
            size="sm"
            closeOnOverlay={!busy}
            closeOnEscape={!busy}
            initialFocusRef={cancelRef}
            footer={
                <>
                    <Button ref={cancelRef} variant="ghost" onClick={close} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button variant={tone} onClick={onConfirm} loading={busy}>
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            <div className="text-sm text-[var(--jale-ink-2)]">{body}</div>
        </Modal>
    );
}
