'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { useReportCategoryHint } from '@/components/report/report-problem-context';
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
 *
 * The actions say what they do in words at every width: on a phone an icon
 * alone left the worker guessing which one deletes. Below `sm` they sit on
 * their own line under the document, so the labels never squeeze the name.
 *
 * DELETE ASKS FIRST, IN PLACE. The first press swaps the actions for the
 * question and a Delete / Cancel pair inside this slot -- no dialog, so
 * nothing stacks over the page and the worker keeps their place in the list.
 * Focus goes to Cancel (the safe choice) while it is open, and back to the
 * button that opened it when it closes.
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
  const [confirming, setConfirming] = useState(false);
  const confirmLabelId = useId();
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the confirm opens or closes. Set by the handler that
  // changes it, applied after the commit, when the target button exists.
  const pendingFocusRef = useRef<'upload' | 'delete' | 'cancel' | null>(null);
  const busy = busyAction !== null;

  // The question is about one document. When that document goes (deleted from
  // another tab, or the list read again without it) or is replaced, the
  // question goes with it, so the next document here never opens on it. Keyed
  // on the id: a refetch that hands back the same document keeps it open.
  const existingId = props.existing?.id ?? null;
  const [questionFor, setQuestionFor] = useState(existingId);
  if (questionFor !== existingId) {
    setQuestionFor(existingId);
    setConfirming(false);
  }

  const wasConfirmingRef = useRef(false);
  useEffect(() => {
    const closed = wasConfirmingRef.current && !confirming;
    wasConfirmingRef.current = confirming;
    let target = pendingFocusRef.current;
    // Closed under the worker with nothing asked for: the focused button went
    // with the question, so focus lands on this slot's upload button rather
    // than falling back to the top of the page.
    if (!target && closed && document.activeElement === document.body) target = 'upload';
    if (!target || busy) return;
    pendingFocusRef.current = null;
    const ref = target === 'cancel' ? cancelButtonRef : target === 'delete' ? deleteButtonRef : uploadButtonRef;
    ref.current?.focus();
  }, [confirming, busy]);

  function askToDelete() {
    pendingFocusRef.current = 'cancel';
    setConfirming(true);
  }

  function cancelDelete() {
    pendingFocusRef.current = 'delete';
    setConfirming(false);
  }
  // A report opened mid-upload, or after one failed, is about uploads.
  useReportCategoryHint(busyAction === 'upload' || error ? 'uploads' : null);

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
      // The Delete button goes with the document; the slot's own upload
      // button is what is left to focus.
      pendingFocusRef.current = 'upload';
      props.onChange();
    } catch (e) {
      // Same as the upload path: no raw code, no untranslated token.
      setError(errorMessage(e));
      pendingFocusRef.current = 'delete';
    } finally {
      setConfirming(false);
      setBusyAction(null);
    }
  }

  return (
    <div className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
            <p data-private className="mt-1 truncate text-xs text-[var(--jale-ink-2)]">
              {props.existing.file_name} · {formatLongDate(props.existing.uploaded_at, locale)}
            </p>
          )}
        </div>

        {confirming && props.existing ? (
          <div
            role="group"
            aria-labelledby={confirmLabelId}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !busy) cancelDelete();
            }}
            className="flex flex-wrap items-center gap-2 sm:justify-end"
          >
            <p id={confirmLabelId} className="w-full text-sm font-semibold text-[var(--jale-ink)] sm:w-auto">
              {t('delete_confirm')}
            </p>
            <Button
              variant="error"
              size="sm"
              onClick={handleDelete}
              disabled={busy}
              aria-busy={busyAction === 'delete' || undefined}
            >
              {busyAction === 'delete' ? <Spinner size="md" /> : <Icon name="trash" />}
              {t('delete')}
            </Button>
            <Button ref={cancelButtonRef} variant="outline" size="sm" onClick={cancelDelete} disabled={busy}>
              {t('delete_cancel')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            {props.existing && (
              <a
                href={props.existing.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded px-2 text-xs font-semibold text-[var(--jale-blue-700)] underline hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                <Icon name="eye" />
                {t('view')}
              </a>
            )}
            <Button
              ref={uploadButtonRef}
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
            >
              {busyAction === 'upload' ? <Spinner size="md" /> : <Icon name="upload" />}
              {props.existing ? t('replace') : t('upload')}
            </Button>
            {props.existing && (
              <Button
                ref={deleteButtonRef}
                variant="outline"
                size="sm"
                onClick={askToDelete}
                disabled={busy}
              >
                <Icon name="trash" />
                {t('delete')}
              </Button>
            )}
          </div>
        )}
        <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={handleFile} />
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
