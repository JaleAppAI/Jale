'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  confirmUpload,
  getUploadUrl,
  submitUpload,
  uploadFileToS3,
  type DocType,
} from '@/lib/api/worker';
import { classifyError } from '@/lib/api/errors';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { KVList } from '@/components/ui/kv-list';
import { Spinner } from '@/components/ui/spinner';

export const dynamic = 'force-dynamic';

// Hand-mirrored from DOC_TYPES in infra/lambda/lib/job-fields.ts (see note on
// DocType in @/lib/api/worker) -- the token flow now accepts all four types.
const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'work_auth_doc', 'certification_doc'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

/**
 * Page frame. `loading.tsx` renders this exact box around a
 * `CenteredCardSkeleton`, so the route skeleton and the real page occupy the
 * same geometry and the swap costs no layout shift. Change one, change both.
 */
const FRAME = 'min-h-[calc(100vh-3.5rem)] bg-[var(--jale-paper)] px-4 py-8';
const COLUMN = 'mx-auto w-full max-w-md anim-fade-in';

/**
 * Is this failure the one-time link itself being unusable?
 *
 * The documents API answers `401 invalid_token` from BOTH the presign call and
 * the final submit whenever the token hash is unknown, already spent, or past
 * `expires_at` — the three ways one of these links dies. Nothing on this route
 * carries a session, so a 401/410 here can only ever be about the link; the
 * kind check backs the code check up rather than narrowing it.
 */
function isDeadLink(err: unknown): boolean {
  const { kind, code } = classifyError(err);
  return code === 'invalid_token' || kind === 'unauthorized' || kind === 'gone';
}

/**
 * The slot is finished, but the link is still good for the other documents.
 * `document_already_confirmed` (presign) is unambiguous;
 * `invalid_or_confirmed_upload` (confirm) is not — see `handleSubmit`.
 */
function isSlotAlreadyConfirmed(err: unknown): boolean {
  const { code } = classifyError(err);
  return code === 'document_already_confirmed' || code === 'invalid_or_confirmed_upload';
}

interface UploadedDoc {
  file: File;
  s3_key: string;
}

export default function WorkerUploadPage() {
  const t = useTranslations('upload_page');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
  const params = useParams();
  const token = params.token as string;

  const [uploads, setUploads] = useState<Partial<Record<DocType, UploadedDoc>>>({});
  const [confirmedDocs, setConfirmedDocs] = useState<Partial<Record<DocType, boolean>>>({});
  const [slotErrors, setSlotErrors] = useState<Partial<Record<DocType, string>>>({});
  const [uploadingDocs, setUploadingDocs] = useState<Partial<Record<DocType, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  /** S9. Terminal: there is no retry that can bring a spent link back. */
  const [linkDead, setLinkDead] = useState(false);

  const docLabel: Record<DocType, string> = {
    resume: t('doc_resume'),
    driver_license: t('doc_driver_license'),
    ssn: t('doc_ssn'),
    work_auth_doc: t('doc_work_auth_doc'),
    certification_doc: t('doc_certification_doc'),
  };

  const handleFileSelect = async (doc_type: DocType, file: File) => {
    setSlotErrors((prev) => ({ ...prev, [doc_type]: undefined }));

    if (file.size > MAX_FILE_SIZE) {
      setSlotErrors((prev) => ({ ...prev, [doc_type]: t('error_size') }));
      return;
    }
    if (!ACCEPTED_MIME.includes(file.type)) {
      setSlotErrors((prev) => ({ ...prev, [doc_type]: t('error_type') }));
      return;
    }

    setUploadingDocs((prev) => ({ ...prev, [doc_type]: true }));
    try {
      const { url, s3_key } = await getUploadUrl(token, doc_type, file.type);
      await uploadFileToS3(url, file);
      setUploads((prev) => ({ ...prev, [doc_type]: { file, s3_key } }));
      setConfirmedDocs((prev) => ({ ...prev, [doc_type]: false }));
    } catch (err) {
      // The presign call is the first thing every attempt does, which is what
      // turns a dead link into an answer on the user's FIRST action instead of
      // a mystery at submit time.
      if (isDeadLink(err)) {
        setLinkDead(true);
        return;
      }
      setSlotErrors((prev) => ({
        ...prev,
        [doc_type]: isSlotAlreadyConfirmed(err)
          ? t('error_already_received')
          : errorMessage(err, { unknown: t('error_upload') }),
      }));
    } finally {
      setUploadingDocs((prev) => ({ ...prev, [doc_type]: false }));
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      for (const doc_type of DOC_TYPES) {
        const uploaded = uploads[doc_type];
        if (!uploaded || confirmedDocs[doc_type]) continue;

        try {
          await confirmUpload(token, uploaded.s3_key, doc_type, uploaded.file);
        } catch (err) {
          if (isDeadLink(err)) {
            setLinkDead(true);
            return;
          }
          // `invalid_or_confirmed_upload` is deliberately ambiguous on the
          // backend: the slot may already be confirmed, or the token may have
          // died since the presign. Carrying on is what disambiguates it —
          // `submitUpload` answers 200 in the first case and 401 invalid_token
          // in the second, which lands on the terminal screen below. Stopping
          // here instead would strand the user on a retry that can never work.
          if (!isSlotAlreadyConfirmed(err)) throw err;
        }
        setConfirmedDocs((prev) => ({ ...prev, [doc_type]: true }));
      }

      await submitUpload(token);
      setSubmitted(true);
    } catch (err) {
      if (isDeadLink(err)) {
        setLinkDead(true);
        return;
      }
      // The only conflict left at this point is `confirm_required` — nothing
      // the backend accepted made it through.
      setSubmitError(
        errorMessage(err, {
          conflict: t('error_confirm_required'),
          unknown: t('error_submit'),
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const uploadedCount = DOC_TYPES.filter((d) => uploads[d]).length;

  /* ===== S9 — invalid or expired link (terminal) ========================= */

  if (linkDead) {
    return (
      <main className={FRAME}>
        <div className={COLUMN}>
          <Card className="p-2">
            {/*
              `unauthorized` is what `classifyError` actually returns for the
              401 that puts us here, and ErrorState offers neither a retry nor a
              back link for it — so this screen structurally cannot grow a
              button that re-runs a request the link can no longer satisfy. Both
              strings are overridden; the kind only picks the icon and tone.
            */}
            <ErrorState
              kind="unauthorized"
              title={t('expired_title')}
              body={t('expired_body')}
            />
          </Card>
        </div>
      </main>
    );
  }

  /* ===== S7 success ====================================================== */

  if (submitted) {
    const receipt = DOC_TYPES.filter((d) => uploads[d]).map((d) => ({
      label: docLabel[d],
      value: uploads[d]!.file.name,
    }));

    return (
      <main className={FRAME}>
        <div className={COLUMN}>
          <Card className="p-6">
            <div className="text-center">
              <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]">
                <Icon name="check" />
              </span>
              <h1 className="text-xl font-extrabold tracking-[-0.02em] text-[var(--jale-ink)]">
                {t('success_title')}
              </h1>
              <p className="mt-1.5 text-sm text-[var(--jale-ink-2)]">{t('success_body')}</p>
            </div>

            {receipt.length > 0 ? (
              <div className="mt-5 border-t border-[var(--jale-divider)] pt-1">
                <KVList items={receipt} />
              </div>
            ) : null}
          </Card>
        </div>
      </main>
    );
  }

  /* ===== S2 form ========================================================= */

  return (
    <main className={FRAME}>
      <div className={COLUMN}>
        <Card className="overflow-hidden">
          <header className="border-b border-[var(--jale-divider)] px-6 pb-5 pt-6">
            <h1 className="text-xl font-extrabold tracking-[-0.02em] text-[var(--jale-ink)]">
              {t('title')}
            </h1>
            {/* The pre-upload explainer: what the link is for, and what it expects. */}
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--jale-ink-2)]">
              {t('explainer')}
            </p>
          </header>

          <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-6 py-3">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
              {t('documents_heading')}
            </h2>
            <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--jale-ink-2)]">
              {t('progress', { done: uploadedCount, total: DOC_TYPES.length })}
            </span>
          </div>

          <ul className="divide-y divide-[var(--jale-divider)]">
            {DOC_TYPES.map((doc_type) => {
              const uploaded = uploads[doc_type];
              const slotError = slotErrors[doc_type];
              const uploading = !!uploadingDocs[doc_type];
              const busy = uploading || submitting;

              return (
                <li key={doc_type} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--jale-ink)]">
                        {docLabel[doc_type]}
                      </p>
                      <div className="mt-1.5">
                        {uploaded ? (
                          <Badge tone="success">{t('uploaded')}</Badge>
                        ) : (
                          <Badge tone="neutral">{t('status_missing')}</Badge>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-[var(--jale-ink-2)]">
                        {uploaded ? uploaded.file.name : t('file_hint')}
                      </p>
                    </div>

                    {/*
                      The input stays `sr-only` rather than `hidden`: a
                      display:none input is not focusable, which would leave the
                      only control on this page unreachable by keyboard. The
                      label carries the focus ring via `focus-within`.
                    */}
                    <label
                      className={[
                        'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full px-4',
                        'border border-[var(--jale-divider)] bg-[var(--jale-card)]',
                        'text-xs font-semibold text-[var(--jale-ink)]',
                        'transition-all duration-150 hover:bg-[var(--jale-paper-2)]',
                        'focus-within:shadow-[var(--shadow-focus)]',
                        busy ? 'pointer-events-none opacity-50' : 'cursor-pointer',
                      ].join(' ')}
                    >
                      {uploading ? <Spinner size="sm" /> : null}
                      <span>
                        {uploading
                          ? tCommon('loading')
                          : uploaded
                            ? t('replace')
                            : t('tap_to_upload')}
                      </span>
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf,.jpg,.jpeg,.png"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          // Clearing the value is what lets the same file be
                          // picked again after a failed attempt; otherwise the
                          // change event never fires a second time.
                          e.target.value = '';
                          if (file) void handleFileSelect(doc_type, file);
                        }}
                      />
                    </label>
                  </div>

                  {slotError ? (
                    <InlineFeedback tone="danger" className="mt-3 text-xs">
                      {slotError}
                    </InlineFeedback>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>

        <p className="mt-4 rounded-[var(--radius-input)] bg-[var(--jale-blue-50)] px-3.5 py-2.5 text-xs font-medium text-[var(--jale-blue-700)]">
          {t('security_notice')}
        </p>

        {submitError ? (
          <InlineFeedback tone="danger" className="mt-4" onDismiss={() => setSubmitError('')}>
            {submitError}
          </InlineFeedback>
        ) : null}

        <Button
          onClick={handleSubmit}
          disabled={uploadedCount === 0}
          loading={submitting}
          loadingLabel={tCommon('loading')}
          className="mt-4 w-full"
        >
          {t('submit')}
        </Button>
        <p className="mt-2 text-center text-xs text-[var(--jale-ink-2)]">{t('submit_hint')}</p>
      </div>
    </main>
  );
}
