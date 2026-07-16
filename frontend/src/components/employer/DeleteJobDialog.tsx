'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/employer';
import { LegalWallError } from '@/lib/api';

/**
 * Shared confirm modal for permanently deleting a job. Follows the PostJobModal overlay
 * pattern (no dialog primitive exists). `onConfirm` performs the delete; a LegalWallError
 * is re-thrown so the calling page can route to the legal wall, while an
 * `ApiError` with code `job_has_hired_workers` shows the specific blocked message.
 */
export function DeleteJobDialog({
  open,
  jobTitle,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  jobTitle: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations('employer_dashboard');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDeleting(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleConfirm() {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      setDeleting(false);
    } catch (err) {
      if (err instanceof LegalWallError) throw err; // let the page route to the legal wall
      if (err instanceof ApiError && err.code === 'job_has_hired_workers') {
        setError(t('jobs.delete.error_hired'));
      } else {
        setError(t('jobs.delete.error_generic'));
      }
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
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
