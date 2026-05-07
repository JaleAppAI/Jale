'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import {
  getWorkerProfile, getWorkerDocuments, createUploadToken,
  WorkerProfile, WorkerDocument,
} from '@/lib/api/employer';

export const dynamic = 'force-dynamic';

type DocType = 'resume' | 'driver_license' | 'ssn';
const ALL_DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];

export default function WorkerProfilePage() {
  const t = useTranslations('employer_dashboard');
  const { idToken } = useAuth();
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const workerId = params.worker_id as string;
  const jobId = searchParams.get('job_id') ?? '';

  const [profile, setProfile] = useState<WorkerProfile | null>(null);
  const [documents, setDocuments] = useState<WorkerDocument[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!idToken || !workerId || !jobId) return;
    Promise.all([
      getWorkerProfile(idToken, workerId, jobId),
      getWorkerDocuments(idToken, workerId, jobId),
    ])
      .then(([p, { documents: docs }]) => {
        setProfile(p);
        setDocuments(docs);
        setStatus(p.application_status);
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, [idToken, workerId, jobId]);

  const handleShareLink = async () => {
    if (!idToken) return;
    try {
      const { upload_url } = await createUploadToken(idToken, jobId, workerId);
      await navigator.clipboard.writeText(upload_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch { setError('Failed to create upload link'); }
  };

  const handleSaveStatus = async () => {
    setSaving(true);
    setTimeout(() => setSaving(false), 500);
  };

  const docByType = (type: DocType) => documents.find(d => d.doc_type === type);

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
    ssn: t('worker_profile.doc_ssn'),
  };

  if (loading) return <div className="p-8 text-center text-gray-500">Loading...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <button onClick={() => router.back()} className="text-blue-900 text-sm mb-4 flex items-center gap-1">
        ← {t('worker_profile.back')}
      </button>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {profile && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="bg-white border rounded-xl p-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center font-bold text-blue-900 text-lg">
                  {profile.full_name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                </div>
                <div>
                  <p className="font-bold text-base">{profile.full_name}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    profile.application_status === 'hired' ? 'bg-green-100 text-green-800' :
                    profile.application_status === 'rejected' ? 'bg-red-100 text-red-800' :
                    'bg-yellow-100 text-yellow-800'
                  }`}>{profile.application_status}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-600">
                <span>📞 {profile.phone}</span>
                <span>📍 {profile.location}</span>
                <span>⭐ {profile.years_experience} yrs exp</span>
                <span>🕐 {profile.availability}</span>
              </div>
            </div>
            <div className="bg-white border rounded-xl p-4">
              <p className="font-semibold mb-2 text-sm">Skills</p>
              <div className="flex flex-wrap gap-2">
                {profile.skills.map(skill => (
                  <span key={skill} className="bg-blue-50 text-blue-800 px-3 py-1 rounded-full text-xs">{skill}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white border rounded-xl p-4">
            <div className="flex justify-between items-center mb-4">
              <p className="font-semibold text-sm">{t('worker_profile.documents')}</p>
              <button onClick={handleShareLink} className="border border-blue-900 text-blue-900 text-xs px-3 py-1.5 rounded-lg">
                {copied ? t('worker_profile.link_copied') : t('worker_profile.share_upload_link')}
              </button>
            </div>
            <div className="space-y-3">
              {ALL_DOC_TYPES.map(type => {
                const doc = docByType(type);
                return (
                  <div key={type} className={`border rounded-lg p-3 ${doc ? 'border-green-200 bg-green-50' : 'border-dashed border-red-300 bg-red-50'}`}>
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="text-sm font-semibold">{docLabel[type]}</p>
                        {doc
                          ? <p className="text-xs text-gray-500">{doc.file_name} · {Math.round(doc.file_size / 1024)} KB</p>
                          : <p className="text-xs text-red-500">{t('worker_profile.not_uploaded')}</p>
                        }
                      </div>
                      {doc ? (
                        <div className="flex gap-2">
                          <a href={doc.url} target="_blank" rel="noreferrer" className="bg-blue-900 text-white text-xs px-3 py-1.5 rounded-lg">
                            {t('worker_profile.view')} ↗
                          </a>
                          <a href={doc.url} download={doc.file_name} className="border border-blue-900 text-blue-900 text-xs px-2 py-1.5 rounded-lg">↓</a>
                        </div>
                      ) : (
                        <button onClick={handleShareLink} className="border border-red-400 text-red-500 text-xs px-3 py-1.5 rounded-lg">
                          {t('worker_profile.request')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 bg-white border rounded-xl p-4 flex justify-between items-center">
        <p className="text-sm text-gray-500">Applied {profile?.applied_at?.slice(0, 10)}</p>
        <div className="flex gap-2 items-center">
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            {['pending', 'reviewed', 'hired', 'rejected'].map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button onClick={handleSaveStatus} disabled={saving} className="bg-blue-900 text-white text-sm px-4 py-1.5 rounded-lg disabled:opacity-50">
            {t('worker_profile.save_status')}
          </button>
        </div>
      </div>
    </div>
  );
}
