'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { createJob, Job } from '@/lib/api/employer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type DocType = 'resume' | 'driver_license' | 'ssn';
const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];

interface Props {
  open: boolean;
  onClose: () => void;
  onJobCreated: (job: Job) => void;
}

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(24,24,85,.45)' }}
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-[var(--radius-card)] bg-white p-7"
        style={{ boxShadow: 'var(--shadow-modal)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between mb-1">
          <h2
            className="font-semibold"
            style={{ fontSize: '1.05rem', color: 'var(--jale-ink)', letterSpacing: '-0.02em' }}
          >
            {t('modal.title')}
          </h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-[var(--jale-paper-2)] transition-colors"
            style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--jale-ink-2)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider mb-5" style={{ color: 'var(--jale-ink-2)' }}>
          Step {step} of 2
        </p>

        {step === 1 ? (
          <>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                  {t('modal.job_title')} *
                </label>
                <Input placeholder="e.g. Forklift operator — Day shift" value={title} onChange={e => setTitle(e.target.value)} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                    {t('modal.location')} *
                  </label>
                  <Input placeholder="Hayward, CA" value={location} onChange={e => setLocation(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                    {t('modal.job_type')}
                  </label>
                  <select
                    className="w-full min-h-[44px] rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] px-3.5 text-sm font-medium text-[var(--jale-ink)] focus:outline-none focus:bg-white focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)] transition-all duration-150"
                    value={jobType}
                    onChange={e => setJobType(e.target.value)}
                  >
                    <option value="full-time">{t('modal.job_type_fulltime')}</option>
                    <option value="part-time">{t('modal.job_type_parttime')}</option>
                    <option value="contract">{t('modal.job_type_contract')}</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--jale-ink-2)' }}>
                  {t('modal.job_description')}
                </label>
                <textarea
                  className="w-full rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-input)] px-3.5 py-2.5 text-sm font-medium text-[var(--jale-ink)] placeholder:text-[var(--jale-placeholder)] focus:outline-none focus:bg-white focus:border-[var(--jale-blue-500)] focus:shadow-[var(--shadow-focus)] transition-all duration-150 resize-none"
                  rows={4}
                  placeholder="What does the job involve? What experience is required?"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <Button variant="ghost" onClick={handleClose} className="flex-1">{t('modal.cancel')}</Button>
              <Button
                variant="deep"
                disabled={!title.trim() || !location.trim()}
                onClick={() => setStep(2)}
                className="flex-1"
              >
                {t('post_job_docs.next')} →
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm mb-4" style={{ color: 'var(--jale-ink-2)' }}>
              {t('post_job_docs.subtitle')}
            </p>

            <div className="flex flex-col gap-2.5 mb-4">
              {DOC_TYPES.map(doc => (
                <div
                  key={doc}
                  className="flex items-center justify-between rounded-[10px] px-4 py-3 border transition-all"
                  style={{
                    background:   requiredDocs[doc] ? 'var(--jale-blue-50)' : 'var(--jale-paper-2)',
                    borderColor:  requiredDocs[doc] ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
                  }}
                >
                  <span className="text-sm font-medium" style={{ color: 'var(--jale-ink)' }}>{docLabel[doc]}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <span style={{ color: requiredDocs[doc] ? 'var(--jale-ink-2)' : 'var(--jale-blue-700)', fontWeight: 600 }}>
                      {t('post_job_docs.optional_label')}
                    </span>
                    <button
                      onClick={() => toggleDoc(doc)}
                      className="w-9 h-5 rounded-full relative transition-colors"
                      style={{ background: requiredDocs[doc] ? 'var(--jale-blue-500)' : 'var(--jale-divider)', border: 0, cursor: 'pointer' }}
                    >
                      <span
                        className="absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all"
                        style={{ left: requiredDocs[doc] ? 'calc(100% - 18px)' : 2 }}
                      />
                    </button>
                    <span style={{ color: requiredDocs[doc] ? 'var(--jale-blue-700)' : 'var(--jale-ink-2)', fontWeight: 600 }}>
                      {t('post_job_docs.required_label')}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {error && <p className="text-sm mb-3" style={{ color: 'var(--jale-danger)' }}>{error}</p>}

            <div className="flex gap-2 mt-6">
              <Button variant="ghost" onClick={() => setStep(1)} className="flex-1">
                {t('post_job_docs.back')}
              </Button>
              <Button variant="deep" disabled={loading} onClick={handleSubmit} className="flex-1">
                {loading ? '...' : t('post_job_docs.submit')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
