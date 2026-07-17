'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Shared confirm modal for permanently deleting a job. Follows the PostJobModal overlay
 * pattern (no dialog primitive exists). The parent owns the deleting/error state
 * so one delete attempt cannot leak loading state into the next selected job.
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

  if (!open) return null;

  async function handleConfirm() {
    if (deleting) return;
    await onConfirm();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => {
        if (!deleting) onCancel();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[var(--jale-paper)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-[var(--jale-ink)]">{t('jobs.delete.confirm_title')}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
          {t('jobs.delete.confirm_body', { title: jobTitle })}
        </p>
        {error && (
          <p className="mt-3 rounded-lg bg-[var(--jale-danger-bg)] px-3 py-2 text-sm text-[var(--jale-danger)]">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            {t('jobs.delete.cancel')}
          </Button>
          <Button
            variant="error"
            onClick={handleConfirm}
            loading={deleting}
            loadingLabel={t('jobs.delete.confirm_cta')}
          >
            {t('jobs.delete.confirm_cta')}
          </Button>
        </div>
      </div>
    </div>
  );
}
