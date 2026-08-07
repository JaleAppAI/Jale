import { apiFetch } from '../api';
import type { ApplicationStatus, JobStatus } from '../status';

export interface UploadUrlResponse {
  url: string;
  s3_key: string;
}

export type DocType = 'resume' | 'driver_license' | 'ssn';
export type JobDocType = 'resume' | 'driver_license';

export async function getUploadUrl(
  token: string,
  doc_type: DocType,
  mime_type: string,
): Promise<UploadUrlResponse> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/upload-url`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, doc_type, mime_type }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'upload_url_failed');
  return res.json();
}

export async function uploadFileToS3(presignedUrl: string, file: File): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!res.ok) throw new Error('s3_upload_failed');
}

export async function confirmUpload(
  token: string,
  s3_key: string,
  doc_type: DocType,
  file: File,
): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        s3_key,
        doc_type,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
      }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'confirm_failed');
}

export async function submitUpload(token: string): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/submit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'submit_failed');
}

// Authenticated marketplace helpers

export type Job = {
  id: string;
  title: string;
  location: string;
  job_type: 'full-time' | 'part-time' | 'contract';
  company?: string;
  company_name: string;
  pay?: string;
  pay_min?: number | null;
  pay_max?: number | null;
  pay_interval?: string | null;
  required_experience_months?: number | null;
  start_date?: string | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  transportation_required?: boolean | null;
  work_authorization_required?: boolean | null;
  language_preference?: Array<'any' | 'en' | 'es'> | null;
  number_of_workers_needed?: number | null;
  hired_count?: number | null;
  open_count?: number | null;
  trade_category?: string | null;
  required_experience_years?: number | null;
  certifications?: string[] | null;
  required_docs: JobDocType[];
  created_at: string;
  match_score?: number;
  match_reasons?: string[];
};

export type JobDetail = Job & {
  description: string | null;
  status?: JobStatus;
  already_applied: boolean;
  application_status: ApplicationStatus | null;
  missing_docs: JobDocType[];
};

export type Application = {
  application_id: string;
  job_id: string;
  job_title: string;
  company_name: string;
  status: ApplicationStatus;
  applied_at: string;
};

export type WorkerTrade = 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'other';
export type WorkerExperience = '0-1' | '2-4' | '5-9' | '10+';
export type WorkerAvailability = 'full_time' | 'part_time' | 'weekends' | 'flexible';

export type PreferredCity = {
  city_key: string;
  city: string;
  state: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type WorkerProfileData = {
  id: string;
  phone: string;
  full_name: string | null;
  skills: string[];
  availability: WorkerAvailability | null;
  years_experience: number | null;
  location: string | null;
  bio: string | null;
  city?: string | null;
  main_trade?: WorkerTrade | null;
  main_trade_other?: string | null;
  has_transportation?: boolean | null;
  certifications?: string[] | null;
  preferred_cities?: PreferredCity[];
};

export type WorkerVaultDoc = {
  doc_type: DocType;
  s3_key: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string;
};

/**
 * `latitude`/`longitude` must be sent together (all-or-none) — sending only
 * one is meaningless to the backend geocode/coordinate write path.
 * `preferred_cities`, when present, replaces the worker's full preferred-city
 * list (already declared on `WorkerProfileData`; not re-declared here).
 */
export type WorkerProfilePatch = Partial<Omit<WorkerProfileData, 'id' | 'phone' | 'years_experience'> & {
  years_experience: number | WorkerExperience | null;
  latitude: number;
  longitude: number;
  location_source: 'geocoded_zip' | 'geocoded_address';
}>;

export type WorkerApiError = Error & {
  status?: number;
  code?: string;
  missing_docs?: string[];
};

async function readErrorBody(res: Response): Promise<{ error?: string; missing_docs?: string[] }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function getJobs(
  token: string,
  filters?: { search?: string; job_type?: string },
): Promise<{ jobs: Job[]; other_jobs?: Job[] }> {
  const qs = new URLSearchParams();
  if (filters?.search) qs.set('search', filters.search);
  if (filters?.job_type) qs.set('job_type', filters.job_type);
  const path = `/worker/jobs${qs.toString() ? `?${qs}` : ''}`;
  const res = await apiFetch(path, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function getJob(token: string, id: string): Promise<JobDetail> {
  const res = await apiFetch(`/worker/jobs/${id}`, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function applyToJob(token: string, id: string): Promise<Application> {
  const res = await apiFetch(`/worker/jobs/${id}/apply`, { method: 'POST' }, token);
  if (!res.ok) {
    const body = await readErrorBody(res);
    const err = new Error(body.error ?? 'apply_failed') as WorkerApiError;
    err.status = res.status;
    err.code = body.error;
    err.missing_docs = body.missing_docs;
    throw err;
  }
  return res.json();
}

export async function getApplications(token: string): Promise<{ applications: Application[] }> {
  const res = await apiFetch('/worker/applications', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function updateWorkerProfile(
  token: string,
  patch: WorkerProfilePatch,
): Promise<WorkerProfileData> {
  const res = await apiFetch('/worker/profile', { method: 'PATCH', body: JSON.stringify(patch) }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'update_failed');
  return res.json();
}

export async function getVaultDocuments(token: string): Promise<{ documents: WorkerVaultDoc[] }> {
  const res = await apiFetch('/worker/vault', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function getAuthUploadUrl(
  token: string,
  doc_type: DocType,
  mime_type: string,
): Promise<UploadUrlResponse> {
  const res = await apiFetch(
    '/worker/vault/upload-url',
    { method: 'POST', body: JSON.stringify({ doc_type, mime_type }) },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'upload_url_failed');
  return res.json();
}

export async function confirmAuthUpload(
  token: string,
  s3_key: string,
  doc_type: DocType,
  file: File,
): Promise<void> {
  const res = await apiFetch(
    '/worker/vault/confirm',
    {
      method: 'POST',
      body: JSON.stringify({
        s3_key, doc_type,
        file_name: file.name, file_size: file.size, mime_type: file.type,
      }),
    },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'confirm_failed');
}

export async function deleteVaultDocument(token: string, doc_type: DocType): Promise<void> {
  const res = await apiFetch(`/worker/vault/${doc_type}`, { method: 'DELETE' }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'delete_failed');
}

// Job-referral sharing (ShareJobPanel)

export type ShareChannel = 'whatsapp' | 'sms' | 'facebook' | 'copy_link' | 'device_share';

export interface ShareJobResponse {
  code: string;
  channel: ShareChannel;
  share_url: string;
}

/**
 * Mints (or refreshes) this worker's share link for one (job, channel) pair.
 * Must be called separately for each channel button -- the per-channel call
 * is what makes the resulting attribution data meaningful, so never reuse a
 * `share_url` obtained for one channel on a different channel's handoff.
 */
export async function shareJob(
  token: string,
  jobId: string,
  channel: ShareChannel,
): Promise<ShareJobResponse> {
  const res = await apiFetch(`/worker/jobs/${jobId}/share`, { method: 'POST', body: JSON.stringify({ channel }) }, token);
  if (!res.ok) {
    const body = await readErrorBody(res);
    const err = new Error(body.error ?? 'share_failed') as WorkerApiError;
    err.status = res.status;
    err.code = body.error;
    throw err;
  }
  return res.json();
}

export interface ClaimReferralResponse {
  claimed: boolean;
}

/**
 * Claims a referral share code for the just-authenticated worker. Called
 * best-effort right after OTP verification in the web-apply carry-through --
 * a bad/expired code must never break signup, so callers should wrap this in
 * their own try/catch and swallow failures.
 */
export async function claimReferral(token: string, shareCode: string): Promise<ClaimReferralResponse> {
  const res = await apiFetch('/worker/referrals/claim', { method: 'POST', body: JSON.stringify({ shareCode }) }, token);
  if (!res.ok) {
    const body = await readErrorBody(res);
    const err = new Error(body.error ?? 'claim_failed') as WorkerApiError;
    err.status = res.status;
    err.code = body.error;
    throw err;
  }
  return res.json();
}
