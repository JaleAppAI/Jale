'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';

/**
 * Confirm for closing a job. NOT destructive — reopen exists (subject to the
 * plan's active-job limit, which the body copy states honestly) — so the
 * confirm button is `outline`, never `error`.
 *
 * Same contract as DeleteJobDialog: the parent owns `closing`/`error`; while a
 * close is in flight every dismissal route is disarmed; a FAILED close keeps
 * the dialog open with the reason inline; only success closes it.
 *
 * Lives off `employer_job_listing` (the detail page's own namespace) —
 * DeleteJobDialog is shared with the dashboard and uses `employer_dashboard`.
 */
export function CloseJobDialog({
  open,
  jobTitle,
  closing,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  jobTitle: string;
  closing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations('employer_job_listing');

  // Open on the SAFE action: without this, Modal focuses the header's dismiss
  // button and a keyboard user's first Tab lands on the confirm.
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function handleConfirm() {
    if (closing) return;
    await onConfirm();
  }

  function handleDismiss() {
    if (closing) return;
    onCancel();
  }

  return (
    <Modal
      open={open}
      onClose={handleDismiss}
      title={t('actions.close_confirm_title')}
      size="sm"
      closeOnOverlay={!closing}
      closeOnEscape={!closing}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={handleDismiss} disabled={closing}>
            {t('actions.close_cancel')}
          </Button>
          <Button
            variant="outline"
            onClick={handleConfirm}
            loading={closing}
            loadingLabel={t('actions.close_pending')}
          >
            {t('actions.close_confirm_cta')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-[var(--jale-ink-2)]">
        {t('actions.close_confirm_body', { title: jobTitle })}
      </p>

      {error ? (
        <InlineFeedback tone="danger" className="mt-4">
          {error}
        </InlineFeedback>
      ) : null}
    </Modal>
  );
}
