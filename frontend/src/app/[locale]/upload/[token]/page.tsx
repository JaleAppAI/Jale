'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getUploadUrl, uploadFileToS3, confirmUpload, submitUpload, DocType } from '@/lib/api/worker';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/png'];

interface UploadedDoc { file: File; s3_key: string; }

export default function WorkerUploadPage() {
  const t = useTranslations('upload_page');
  const tCommon = useTranslations('common');
  const params = useParams();
  const token = params.token as string;

  const [uploads, setUploads] = useState<Partial<Record<DocType, UploadedDoc>>>({});
  const [errors, setErrors] = useState<Partial<Record<DocType, string>>>({});
  const [uploadingDocs, setUploadingDocs] = useState<Partial<Record<DocType, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [globalError, setGlobalError] = useState('');

  const docLabel: Record<DocType, string> = {
    resume: t('doc_resume'),
    driver_license: t('doc_driver_license'),
    ssn: t('doc_ssn'),
  };

  const handleFileSelect = async (doc_type: DocType, file: File) => {
    setErrors(prev => ({ ...prev, [doc_type]: undefined }));

    if (file.size > MAX_FILE_SIZE) {
      setErrors(prev => ({ ...prev, [doc_type]: t('error_size') }));
      return;
    }
    if (!ACCEPTED_MIME.includes(file.type)) {
      setErrors(prev => ({ ...prev, [doc_type]: t('error_type') }));
      return;
    }

    setUploadingDocs(prev => ({ ...prev, [doc_type]: true }));
    try {
      const { url, s3_key } = await getUploadUrl(token, doc_type, file.type);
      await uploadFileToS3(url, file);
      setUploads(prev => ({ ...prev, [doc_type]: { file, s3_key } }));
    } catch {
      setErrors(prev => ({ ...prev, [doc_type]: 'Upload failed. Please try again.' }));
    } finally {
      setUploadingDocs(prev => ({ ...prev, [doc_type]: false }));
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setGlobalError('');
    try {
      for (const doc_type of DOC_TYPES) {
        const uploaded = uploads[doc_type];
        if (uploaded) {
          await confirmUpload(token, uploaded.s3_key, doc_type, uploaded.file);
        }
      }
      await submitUpload(token);
      setSubmitted(true);
    } catch {
      setGlobalError('Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const uploadedCount = DOC_TYPES.filter(d => uploads[d]).length;

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-xl font-bold mb-2">{t('success_title')}</h1>
          <p className="text-gray-500">{t('success_body')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-6">
          <p className="text-2xl font-bold text-blue-900 mb-1">Jale</p>
          <h1 className="text-base font-semibold">{t('title')}</h1>
        </div>

        <div className="flex gap-1 mb-6">
          {DOC_TYPES.map((_, i) => (
            <div key={i} className={`flex-1 h-1 rounded-full ${i < uploadedCount ? 'bg-blue-900' : 'bg-gray-200'}`} />
          ))}
        </div>

        <div className="space-y-3 mb-6">
          {DOC_TYPES.map(doc_type => {
            const uploaded = uploads[doc_type];
            const err = errors[doc_type];
            const uploading = !!uploadingDocs[doc_type];
            return (
              <div key={doc_type} className={`bg-white border rounded-xl p-4 ${uploaded ? 'border-green-300' : 'border-gray-200'}`}>
                <p className="text-sm font-semibold mb-1">{docLabel[doc_type]}</p>
                {uploaded ? (
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-green-700">✅ {uploaded.file.name}</p>
                    <label className={`inline-flex items-center gap-1.5 text-xs border px-2 py-1 rounded text-gray-500 ${uploading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                      {uploading && <InlineSpinner />}
                      {uploading ? tCommon('loading') : t('replace')}
                      <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png" disabled={uploading || submitting}
                        onChange={e => e.target.files?.[0] && handleFileSelect(doc_type, e.target.files[0])} />
                    </label>
                  </div>
                ) : (
                  <label className={`block border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-900 transition-colors ${uploading ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                    <p className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-blue-900">
                      {uploading && <InlineSpinner />}
                      {uploading ? tCommon('loading') : t('tap_to_upload')}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{t('file_hint')}</p>
                    {err && <p className="text-xs text-red-500 mt-1">{err}</p>}
                    <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png" disabled={uploading || submitting}
                      onChange={e => e.target.files?.[0] && handleFileSelect(doc_type, e.target.files[0])} />
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <div className="bg-blue-50 rounded-lg p-3 mb-4 text-xs text-gray-600 text-center">
          🔒 {t('security_notice')}
        </div>

        {globalError && <p className="text-red-500 text-sm text-center mb-3">{globalError}</p>}

        <Button
          onClick={handleSubmit}
          disabled={uploadedCount === 0}
          loading={submitting}
          loadingLabel={tCommon('loading')}
          className="w-full rounded-xl bg-blue-900 text-white shadow-none hover:bg-blue-950"
        >
          {t('submit')}
        </Button>
        <p className="text-center text-xs text-gray-400 mt-2">{t('submit_hint')}</p>
      </div>
    </div>
  );
}

function InlineSpinner() {
  return (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
