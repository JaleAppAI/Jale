import { apiFetch } from '../api';

export interface UploadUrlResponse {
  url: string;
  s3_key: string;
}

export type DocType = 'resume' | 'driver_license' | 'ssn';

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

// ── Authenticated marketplace helpers ──────────────────────────────────────

export type Job = {
  id: string;
  title: string;
  location: string;
  job_type: 'full-time' | 'part-time' | 'contract';
  company_name: string;
  required_docs: DocType[];
  created_at: string;
};

export type JobDetail = Job & {
  description: string | null;
  already_applied: boolean;
  application_status: 'pending' | 'reviewed' | 'hired' | 'rejected' | null;
  missing_docs: DocType[];
};

export type Application = {
  application_id: string;
  job_id: string;
  job_title: string;
  company_name: string;
  status: 'pending' | 'reviewed' | 'hired' | 'rejected';
  applied_at: string;
};

export type WorkerTrade = 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'other';
export type WorkerExperience = '0-1' | '2-4' | '5-9' | '10+';
export type WorkerAvailability = 'full_time' | 'part_time' | 'weekends' | 'flexible';

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
};

export type WorkerVaultDoc = {
  doc_type: DocType;
  s3_key: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string;
};

export type WorkerProfilePatch = Partial<Omit<WorkerProfileData, 'id' | 'phone' | 'years_experience'> & {
  years_experience: number | WorkerExperience | null;
}>;

export async function getJobs(
  token: string,
  filters?: { search?: string; job_type?: string },
): Promise<{ jobs: Job[] }> {
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
    const body = await res.json();
    const err = new Error(body.error ?? 'apply_failed') as Error & { status?: number; missing_docs?: string[] };
    err.status = res.status;
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
