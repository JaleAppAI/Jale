'use client';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { getAuthUploadUrl, confirmAuthUpload, deleteVaultDocument, uploadFileToS3 } from '@/lib/api/worker';
import { formatLongDate } from '@/lib/date';
import type { DocType, WorkerVaultDoc } from '@/lib/api/worker';

/**
 * One document slot in the vault list.
 *
 * The slot draws no box of its own: the profile page stacks these inside a
 * single bordered container with divider rules, so a row here is a row of that
 * list rather than a card floating next to other cards.
 *
 * Every outcome of an upload/delete is expressed in place, scoped to this slot:
 * a spinner and a busy Button while the request is in flight, the presence
 * Badge flipping to "Uploaded" (plus an ambient toast) on success, and a
 * kind-classified `InlineFeedback` on failure. Nothing here ever renders
 * `err.message` -- see `useErrorMessage`.
 */
export function DocumentSlot(props: {
  token: string;
  doc_type: DocType;
  existing?: WorkerVaultDoc;
  onChange: () => void;
}) {
  const t = useTranslations('worker_profile.documents');
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busyAction, setBusyAction] = useState<'upload' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = busyAction !== null;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusyAction('upload'); setError(null);
    try {
      const { url, s3_key } = await getAuthUploadUrl(props.token, props.doc_type, file.type);
      await uploadFileToS3(url, file);
      await confirmAuthUpload(props.token, s3_key, props.doc_type, file);
      toast.success(t('upload_success'));
      props.onChange();
    } catch (e) {
      // Was `err.message` falling back to the literal token 'upload_failed',
      // which reached the user as that raw string in both locales.
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleDelete() {
    setBusyAction('delete'); setError(null);
    try {
      await deleteVaultDocument(props.token, props.doc_type);
      toast.success(t('delete_success'));
      props.onChange();
    } catch (e) {
      // Same as the upload path: no raw code, no untranslated token.
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--jale-ink)]">{t(`types.${props.doc_type}`)}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {props.existing ? (
              <Badge tone="success">{t('uploaded')}</Badge>
            ) : (
              <Badge tone="neutral">{t('not_uploaded')}</Badge>
            )}

            {busy && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--jale-ink-2)]">
                <Spinner size="sm" />
                {t(busyAction === 'upload' ? 'uploading' : 'deleting')}
              </span>
            )}
          </div>

          {props.existing && (
            <p className="mt-1 truncate text-xs text-[var(--jale-ink-2)]">
              {props.existing.file_name} · {formatLongDate(props.existing.uploaded_at, locale)}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {props.existing && (
            <a href={props.existing.url} target="_blank" rel="noreferrer" aria-label={t('view')} title={t('view')} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--jale-blue-700)] hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] sm:h-auto sm:w-auto sm:gap-1.5 sm:rounded sm:px-2 sm:text-xs sm:font-semibold sm:underline">
              <Icon name="eye" />
              <span className="sr-only sm:not-sr-only">{t('view')}</span>
            </a>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            // Not Button's `loading`: that prop stacks `Spinner + children` in a
            // grid cell the button does not re-measure, so on this icon+label
            // button the loading row overflows and the label wraps under the
            // icon. Swapping the glyph keeps the width identical, and
            // `aria-busy` (which Button's spread lets us set directly) still
            // announces the pending state.
            aria-busy={busyAction === 'upload' || undefined}
            aria-label={props.existing ? t('replace') : t('upload')}
            title={props.existing ? t('replace') : t('upload')}
            // Override Button's default sizeClasses.sm padding (px-4) so the button
            // stays compact when icon-only (label hidden below sm).
            className="!px-2 sm:!px-3"
          >
            {busyAction === 'upload' ? <Spinner size="md" /> : <Icon name="upload" />}
            <span className="sr-only sm:not-sr-only">{props.existing ? t('replace') : t('upload')}</span>
          </Button>
          {props.existing && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={busy}
              // Same reason as the upload button above.
              aria-busy={busyAction === 'delete' || undefined}
              aria-label={t('delete')}
              title={t('delete')}
              // Override Button's default sizeClasses.sm padding (px-4) so the button
              // stays compact when icon-only (label hidden below sm).
              className="!px-2 sm:!px-3"
            >
              {busyAction === 'delete' ? <Spinner size="md" /> : <Icon name="trash" />}
              <span className="sr-only sm:not-sr-only">{t('delete')}</span>
            </Button>
          )}
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={handleFile} />
        </div>
      </div>

      {/* Full-width under the row: a failure here belongs to THIS slot, and at
          390px it needs the whole width to stay a readable sentence. */}
      {error && (
        <InlineFeedback tone="danger" onDismiss={() => setError(null)} className="mt-3">
          {error}
        </InlineFeedback>
      )}
    </div>
  );
}
