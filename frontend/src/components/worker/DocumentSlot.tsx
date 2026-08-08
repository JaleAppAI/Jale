'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { getAuthUploadUrl, confirmAuthUpload, deleteVaultDocument, uploadFileToS3 } from '@/lib/api/worker';
import type { DocType, WorkerVaultDoc } from '@/lib/api/worker';

export function DocumentSlot(props: {
  token: string;
  doc_type: DocType;
  existing?: WorkerVaultDoc;
  onChange: () => void;
}) {
  const t = useTranslations('worker_profile.documents');
  const errorMessage = useErrorMessage();
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
      props.onChange();
    } catch (e) {
      // Same as the upload path: no raw code, no untranslated token.
      setError(errorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t(`types.${props.doc_type}`)}</p>
        {props.existing ? (
          <p className="truncate text-xs text-muted-foreground">
            {props.existing.file_name} · {new Date(props.existing.uploaded_at).toLocaleDateString()}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('not_uploaded')}</p>
        )}
        {error && <p className="text-xs text-error mt-1">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {props.existing && (
          <a href={props.existing.url} target="_blank" rel="noreferrer" aria-label={t('view')} title={t('view')} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-blue-700 hover:bg-[var(--jale-paper-2)] sm:h-auto sm:w-auto sm:gap-1.5 sm:rounded sm:px-2 sm:underline">
            <Icon name="eye" />
            <span className="sr-only sm:not-sr-only">{t('view')}</span>
          </a>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          loading={busyAction === 'upload'}
          aria-label={props.existing ? t('replace') : t('upload')}
          title={props.existing ? t('replace') : t('upload')}
          // Override Button's default sizeClasses.sm padding (px-4) so the button
          // stays compact when icon-only (label hidden below sm).
          className="!px-2 sm:!px-3"
        >
          <Icon name="upload" />
          <span className="sr-only sm:not-sr-only">{props.existing ? t('replace') : t('upload')}</span>
        </Button>
        {props.existing && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={busy}
            loading={busyAction === 'delete'}
            aria-label={t('delete')}
            title={t('delete')}
            // Override Button's default sizeClasses.sm padding (px-4) so the button
            // stays compact when icon-only (label hidden below sm).
            className="!px-2 sm:!px-3"
          >
            <Icon name="trash" />
            <span className="sr-only sm:not-sr-only">{t('delete')}</span>
          </Button>
        )}
        <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={handleFile} />
      </div>
    </div>
  );
}
