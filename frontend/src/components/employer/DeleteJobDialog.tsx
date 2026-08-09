'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Modal } from '@/components/ui/modal';

/**
 * Destructive confirm for permanently deleting a job.
 *
 * Built on the foundation `Modal`, so focus trapping, Escape, the ink backdrop,
 * the scroll lock and the return of focus to the row's delete button all come
 * from one place instead of being re-derived here.
 *
 * The parent owns `deleting`/`error` on purpose: one delete attempt must not be
 * able to leak its pending or failed state into the next job the user selects.
 *
 * While a delete is in flight the dialog stops closing itself — Escape and the
 * backdrop are disarmed and Cancel is disabled — because the request is already
 * out and dismissing the dialog would leave the user with no place for its
 * result to land. A FAILED delete keeps the dialog open with the reason inline;
 * only a success closes it (the parent then toasts and drops the row).
 */
export function DeleteJobDialog({
  open,
  jobTitle,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  jobTitle: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations('employer_dashboard');

  async function handleConfirm() {
    if (deleting) return;
    await onConfirm();
  }

  // Every dismissal route (Escape, backdrop, the header close button) funnels
  // through here, so disarming the first two is not enough — the X has to obey
  // the in-flight guard too.
  function handleDismiss() {
    if (deleting) return;
    onCancel();
  }

  return (
    <Modal
      open={open}
      onClose={handleDismiss}
      title={t('jobs.delete.confirm_title')}
      size="sm"
      closeOnOverlay={!deleting}
      closeOnEscape={!deleting}
      footer={
        <>
          <Button variant="ghost" onClick={handleDismiss} disabled={deleting}>
            {t('jobs.delete.cancel')}
          </Button>
          <Button
            variant="error"
            onClick={handleConfirm}
            loading={deleting}
            loadingLabel={t('jobs.delete.pending')}
          >
            {t('jobs.delete.confirm_cta')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-[var(--jale-ink-2)]">
        {t('jobs.delete.confirm_body', { title: jobTitle })}
      </p>

      {error ? (
        <InlineFeedback tone="danger" className="mt-4">
          {error}
        </InlineFeedback>
      ) : null}
    </Modal>
  );
}
