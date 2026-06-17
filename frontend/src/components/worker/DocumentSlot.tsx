'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { getAuthUploadUrl, confirmAuthUpload, deleteVaultDocument, uploadFileToS3 } from '@/lib/api/worker';
import type { DocType, WorkerVaultDoc } from '@/lib/api/worker';

export function DocumentSlot(props: {
  token: string;
  doc_type: DocType;
  existing?: WorkerVaultDoc;
  onChange: () => void;
}) {
  const t = useTranslations('worker_profile.documents');
  const tCommon = useTranslations('common');
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
      const err = e as Record<string, unknown>;
      setError(typeof err.message === 'string' ? err.message : 'upload_failed');
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
      const err = e as Record<string, unknown>;
      setError(typeof err.message === 'string' ? err.message : 'delete_failed');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex items-center justify-between rounded border p-3">
      <div>
        <p className="text-sm font-medium">{t(`types.${props.doc_type}`)}</p>
        {props.existing ? (
          <p className="text-xs text-muted-foreground">
            {props.existing.file_name} · {new Date(props.existing.uploaded_at).toLocaleDateString()}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('not_uploaded')}</p>
        )}
        {error && <p className="text-xs text-error mt-1">{error}</p>}
      </div>
      <div className="flex gap-2">
        {props.existing && (
          <a href={props.existing.url} target="_blank" rel="noreferrer" className="text-sm text-blue-700 underline self-center">{t('view')}</a>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          loading={busyAction === 'upload'}
          loadingLabel={tCommon('loading')}
        >
          {props.existing ? t('replace') : t('upload')}
        </Button>
        {props.existing && (
          <Button variant="outline" size="sm" onClick={handleDelete} disabled={busy} loading={busyAction === 'delete'} loadingLabel={tCommon('loading')}>{t('delete')}</Button>
        )}
        <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={handleFile} />
      </div>
    </div>
  );
}
