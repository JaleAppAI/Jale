'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Button } from '@/components/ui/button';
import {
  getWorkerProfile, getWorkerDocuments, createUploadToken, updateApplicantStatus,
  WorkerProfile, WorkerDocument, ApplicationStatus,
} from '@/lib/api/employer';
import { applicationStatusTone, normalizeApplicationStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

type DocType = 'resume' | 'driver_license' | 'ssn';
const ALL_DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];
const APPLICATION_STATUSES: ApplicationStatus[] = ['pending', 'contacted', 'talking', 'hired', 'not_interested'];

export default function WorkerProfilePage() {
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const { idToken, isLoading: authLoading } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const workerId = params.worker_id as string;
  const jobId = searchParams.get('job_id') ?? '';

  const [profile, setProfile] = useState<WorkerProfile | null>(null);
  const [documents, setDocuments] = useState<WorkerDocument[]>([]);
  const [status, setStatus] = useState<ApplicationStatus>('pending');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sharingLink, setSharingLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const handleLegalWallRef = useRef(handleLegalWall);

  const missingJobError = t('worker_profile.error_missing_job');
  const loadProfileError = t('worker_profile.error_load_profile');

  useEffect(() => {
    handleLegalWallRef.current = handleLegalWall;
  }, [handleLegalWall]);

  useEffect(() => {
    if (!workerId || !jobId) {
      setError(missingJobError);
      setLoading(false);
      return;
    }

    if (authLoading) return;
    if (!idToken) {
      setLoading(false);
      return;
    }

    setError('');
    setLoading(true);
    Promise.all([
      getWorkerProfile(idToken, workerId, jobId),
      getWorkerDocuments(idToken, workerId, jobId),
    ])
      .then(([p, { documents: docs }]) => {
        setProfile(p);
        setDocuments(docs);
        setStatus(normalizeApplicationStatus(p.application_status));
      })
      .catch((err) => {
        try {
          handleLegalWallRef.current(err, `/employer/workers/${workerId}?job_id=${jobId}`);
        } catch {
          setError(loadProfileError);
        }
      })
      .finally(() => setLoading(false));
  }, [authLoading, idToken, workerId, jobId, loadProfileError, missingJobError]);

  const handleShareLink = async () => {
    if (!idToken || !workerId || !jobId) return;
    setSharingLink(true);
    try {
      const { upload_url } = await createUploadToken(idToken, jobId, workerId);
      await navigator.clipboard.writeText(upload_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      try {
        handleLegalWall(err, `/employer/workers/${workerId}?job_id=${jobId}`);
      } catch {
        setError(t('worker_profile.error_create_link'));
      }
    } finally {
      setSharingLink(false);
    }
  };

  const handleSaveStatus = async () => {
    if (!idToken || !workerId || !jobId || !profile || status === profile.application_status) return;

    setSaving(true);
    setError('');
    try {
      const updated = await updateApplicantStatus(idToken, jobId, workerId, status);
      const nextStatus = updated.status ?? status;
      setStatus(nextStatus);
      setProfile({ ...profile, application_status: nextStatus });
    } catch (err) {
      try {
        handleLegalWall(err, `/employer/workers/${workerId}?job_id=${jobId}`);
      } catch {
        setError(t('worker_profile.error_save_status'));
      }
    } finally {
      setSaving(false);
    }
  };

  const docByType = (type: DocType) => documents.find(d => d.doc_type === type);

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
    ssn: t('worker_profile.doc_ssn'),
  };

  const saveDisabled = saving || !idToken || !workerId || !jobId || !profile || status === profile.application_status;

  const availabilityLabel = (value: WorkerProfile['availability']) => {
    if (!value) return t('worker_profile.fallback_availability');
    const key = value.replaceAll('-', '_');
    if (['immediate', '2_weeks', '1_month', 'full_time', 'part_time', 'weekends', 'flexible'].includes(key)) {
      return t(`worker_profile.availability.${key}`);
    }
    return value;
  };

  const tradeLabel = (trade: WorkerProfile['main_trade'], tradeOther: WorkerProfile['main_trade_other']) => {
    if (!trade) return t('worker_profile.fallback_trade');
    if (trade === 'other') return tradeOther || t('worker_profile.trades.other');
    const knownTrades = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'];
    if (knownTrades.includes(trade)) return t(`worker_profile.trades.${trade}`);
    return trade;
  };

  const displayName = profile?.full_name?.trim() || t('worker_profile.fallback_name');
  const initials = displayName.split(/\s+/).map(name => name[0]).join('').slice(0, 2).toUpperCase() || '?';
  const skills = profile?.skills ?? [];
  const appliedAt = profile?.applied_at ? profile.applied_at.slice(0, 10) : t('worker_profile.fallback_applied');
  const yearsExperience = profile?.years_experience ?? null;

  if (loading) return <div className="p-8 text-center text-gray-500">{tCommon('loading')}</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <button onClick={() => router.back()} className="text-blue-900 text-sm mb-4 flex items-center gap-1">
        &larr; {t('worker_profile.back')}
      </button>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {profile && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="bg-white border rounded-xl p-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center font-bold text-blue-900 text-lg">
                  {initials}
                </div>
                <div>
                  <p className="font-bold text-base">{displayName}</p>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{
                      background: applicationStatusTone(normalizeApplicationStatus(profile.application_status)).bg,
                      color: applicationStatusTone(normalizeApplicationStatus(profile.application_status)).color,
                    }}
                  >
                    {t(`applicants.status.${normalizeApplicationStatus(profile.application_status)}`)}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-600">
                <span>{t('worker_profile.phone')}: {profile.phone || t('worker_profile.fallback_phone')}</span>
                <span>{t('worker_profile.location')}: {profile.city || profile.location || t('worker_profile.fallback_location')}</span>
                <span>
                  {yearsExperience === null
                    ? t('worker_profile.fallback_experience')
                    : t('worker_profile.years_experience', { years: yearsExperience })}
                </span>
                <span>{t('worker_profile.availability_label')}: {availabilityLabel(profile.availability)}</span>
                <span>{t('worker_profile.trade')}: {tradeLabel(profile.main_trade, profile.main_trade_other)}</span>
                <span>
                  {profile.has_transportation === null || profile.has_transportation === undefined
                    ? null
                    : profile.has_transportation
                    ? t('worker_profile.transportation_yes')
                    : t('worker_profile.transportation_no')}
                </span>
              </div>
            </div>

            <div className="bg-white border rounded-xl p-4">
              <p className="font-semibold mb-2 text-sm">{t('worker_profile.skills')}</p>
              <div className="flex flex-wrap gap-2">
                {skills.length > 0 ? (
                  skills.map(skill => (
                    <span key={skill} className="bg-blue-50 text-blue-800 px-3 py-1 rounded-full text-xs">{skill}</span>
                  ))
                ) : (
                  <p className="text-xs text-gray-500">{t('worker_profile.fallback_skills')}</p>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border rounded-xl p-4">
            <div className="flex justify-between items-center mb-4">
              <p className="font-semibold text-sm">{t('worker_profile.documents')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleShareLink}
                disabled={!idToken || !workerId || !jobId}
                loading={sharingLink}
                loadingLabel={tCommon('loading')}
                className="h-8 border-blue-900 text-blue-900"
              >
                {copied ? t('worker_profile.link_copied') : t('worker_profile.share_upload_link')}
              </Button>
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
                          ? <p className="text-xs text-gray-500">{doc.file_name} - {Math.round(doc.file_size / 1024)} KB</p>
                          : <p className="text-xs text-red-500">{t('worker_profile.not_uploaded')}</p>
                        }
                      </div>
                      {doc ? (
                        <div className="flex gap-2">
                          <a href={doc.url} target="_blank" rel="noreferrer" className="bg-blue-900 text-white text-xs px-3 py-1.5 rounded-lg">
                            {t('worker_profile.view')}
                          </a>
                          <a href={doc.url} download={doc.file_name} className="border border-blue-900 text-blue-900 text-xs px-2 py-1.5 rounded-lg">
                            {t('worker_profile.download')}
                          </a>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleShareLink}
                          disabled={!idToken || !workerId || !jobId}
                          loading={sharingLink}
                          loadingLabel={tCommon('loading')}
                          className="h-8 border-red-400 text-red-500 hover:bg-red-50"
                        >
                          {t('worker_profile.request')}
                        </Button>
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
        <p className="text-sm text-gray-500">{t('worker_profile.applied')} {appliedAt}</p>
        <div className="flex gap-2 items-center">
          <select
            value={status}
            onChange={e => setStatus(e.target.value as ApplicationStatus)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            {APPLICATION_STATUSES.map(s => (
              <option key={s} value={s}>{t(`applicants.status.${s}`)}</option>
            ))}
          </select>
          <Button onClick={handleSaveStatus} disabled={saveDisabled} loading={saving} loadingLabel={t('worker_profile.saving_status')} className="h-9 rounded-lg bg-blue-900 px-4 text-sm text-white shadow-none hover:bg-blue-950">
            {t('worker_profile.save_status')}
          </Button>
        </div>
      </div>
    </div>
  );
}
