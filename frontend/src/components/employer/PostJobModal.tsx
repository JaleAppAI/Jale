'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { createJob, Job } from '@/lib/api/employer';

type DocType = 'resume' | 'driver_license' | 'ssn';
const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];

interface Props {
  open: boolean;
  onClose: () => void;
  onJobCreated: (job: Job) => void;
}

// IMPORTANT: named export — dashboard imports this as { PostJobModal }
export function PostJobModal({ open, onClose, onJobCreated }: Props) {
  const t = useTranslations('employer_dashboard');
  const { idToken } = useAuth();

  const [step, setStep] = useState<1 | 2>(1);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [jobType, setJobType] = useState('full-time');
  const [description, setDescription] = useState('');
  const [requiredDocs, setRequiredDocs] = useState<Record<DocType, boolean>>({
    resume: false, driver_license: false, ssn: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  const handleClose = () => {
    setStep(1); setTitle(''); setLocation(''); setJobType('full-time');
    setDescription(''); setRequiredDocs({ resume: false, driver_license: false, ssn: false });
    setError(''); onClose();
  };

  const toggleDoc = (doc: DocType) =>
    setRequiredDocs(prev => ({ ...prev, [doc]: !prev[doc] }));

  const handleSubmit = async () => {
    setLoading(true); setError('');
    try {
      const required_docs = DOC_TYPES.filter(d => requiredDocs[d]);
      const job = await createJob(idToken!, { title, location, job_type: jobType, description, required_docs });
      onJobCreated(job);
      handleClose();
    } catch {
      setError(t('modal.error'));
    } finally {
      setLoading(false);
    }
  };

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
    ssn: t('worker_profile.doc_ssn'),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        {step === 1 ? (
          <>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('modal.title')}</h2>
              <span className="text-sm text-gray-400">Step 1 of 2</span>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">{t('modal.job_title')} *</label>
                <input className="w-full border rounded-lg px-3 py-2 text-sm" value={title} onChange={e => setTitle(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('modal.location')} *</label>
                <input className="w-full border rounded-lg px-3 py-2 text-sm" value={location} onChange={e => setLocation(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('modal.job_type')}</label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={jobType} onChange={e => setJobType(e.target.value)}>
                  <option value="full-time">{t('modal.job_type_fulltime')}</option>
                  <option value="part-time">{t('modal.job_type_parttime')}</option>
                  <option value="contract">{t('modal.job_type_contract')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('modal.job_description')}</label>
                <textarea className="w-full border rounded-lg px-3 py-2 text-sm h-20" value={description} onChange={e => setDescription(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={handleClose} className="flex-1 border rounded-lg py-2 text-sm">{t('modal.cancel')}</button>
              <button
                onClick={() => setStep(2)}
                disabled={!title.trim() || !location.trim()}
                className="flex-2 bg-blue-900 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50 px-6"
              >
                {t('post_job_docs.next')} →
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold">{t('modal.title')}</h2>
              <span className="text-sm text-gray-400">{t('post_job_docs.step_label')}</span>
            </div>
            <p className="text-sm text-gray-500 mb-4">{t('post_job_docs.subtitle')}</p>
            <div className="space-y-3 mb-4">
              {DOC_TYPES.map(doc => (
                <div key={doc} className={`border rounded-lg p-3 flex justify-between items-center ${requiredDocs[doc] ? 'border-blue-900 bg-blue-50' : ''}`}>
                  <span className="text-sm font-medium">{docLabel[doc]}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={requiredDocs[doc] ? 'text-gray-400' : 'text-blue-900 font-semibold'}>{t('post_job_docs.optional_label')}</span>
                    <button
                      onClick={() => toggleDoc(doc)}
                      className={`w-8 h-4 rounded-full relative transition-colors ${requiredDocs[doc] ? 'bg-blue-900' : 'bg-gray-300'}`}
                    >
                      <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${requiredDocs[doc] ? 'right-0.5' : 'left-0.5'}`} />
                    </button>
                    <span className={requiredDocs[doc] ? 'text-blue-900 font-semibold' : 'text-gray-400'}>{t('post_job_docs.required_label')}</span>
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex-1 border rounded-lg py-2 text-sm">{t('post_job_docs.back')}</button>
              <button onClick={handleSubmit} disabled={loading} className="flex-2 bg-blue-900 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-50 px-6">
                {loading ? '...' : t('post_job_docs.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
