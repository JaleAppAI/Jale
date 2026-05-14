import { apiFetch } from '../api';

export type Job = {
  id: string;
  title: string;
  location: string;
  job_type: 'full-time' | 'part-time' | 'contract';
  status: 'active' | 'closed';
  applicant_count: number;
  created_at: string;
};

export type ApplicationStatus = 'pending' | 'reviewed' | 'hired' | 'rejected';

export type Applicant = {
  application_id: string;
  worker_id: string;
  full_name: string | null;
  phone: string | null;
  status: ApplicationStatus;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | null;
  location: string | null;
};

export type ApplicantFilters = {
  status?: string;
  skills?: string;
  availability?: string;
  min_experience?: number;
};

export type EmployerTrade = 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'other';
export type EmployerJobType = 'full-time' | 'part-time' | 'contract';
export type CompanySize = '1-10' | '11-50' | '51-200' | '200+';

export type EmployerProfileData = {
  id: string;
  user_type: 'employer';
  email: string;
  phone: string | null;
  full_name: string | null;
  tenant_id: string | null;
  created_at: string;
  company_name: string | null;
  contact_name: string | null;
  city: string | null;
  service_area: string | null;
  hiring_trades: EmployerTrade[];
  typical_job_types: EmployerJobType[];
  company_size: CompanySize | null;
  company_description: string | null;
};

export type EmployerProfilePatch = Partial<Pick<EmployerProfileData,
  'company_name' | 'contact_name' | 'phone' | 'city' | 'service_area' |
  'hiring_trades' | 'typical_job_types' | 'company_size' | 'company_description'
>>;

export async function getEmployerProfile(token: string): Promise<EmployerProfileData> {
  const res = await apiFetch('/employer/profile', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_fetch_failed');
  return res.json();
}

export async function updateEmployerProfile(
  token: string,
  patch: EmployerProfilePatch,
): Promise<EmployerProfileData> {
  const res = await apiFetch(
    '/employer/profile',
    { method: 'PATCH', body: JSON.stringify(patch) },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_update_failed');
  return res.json();
}

export async function getJobs(token: string): Promise<Job[]> {
  const res = await apiFetch('/employer/jobs', {}, token);
  if (!res.ok) throw new Error('fetch_failed');
  const data = await res.json();
  return data.jobs;
}

export async function createJob(
  token: string,
  data: {
    title: string;
    location: string;
    job_type: string;
    description?: string;
    required_docs?: string[];
  }
): Promise<Job> {
  const res = await apiFetch('/employer/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw new Error('create_failed');
  return res.json();
}

export async function updateJobStatus(
  token: string,
  jobId: string,
  status: 'active' | 'closed'
): Promise<Job> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  }, token);
  if (!res.ok) throw new Error('update_failed');
  return res.json();
}

export async function getJobApplicants(
  token: string,
  jobId: string,
  filters: ApplicantFilters = {}
): Promise<{ applicants: Applicant[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.skills) params.set('skills', filters.skills);
  if (filters.availability) params.set('availability', filters.availability);
  if (filters.min_experience !== undefined) {
    params.set('min_experience', String(filters.min_experience));
  }
  const qs = params.toString();
  const res = await apiFetch(
    `/employer/jobs/${jobId}/applicants${qs ? `?${qs}` : ''}`,
    {},
    token
  );
  if (!res.ok) throw new Error('fetch_failed');
  return res.json();
}

export interface WorkerDocument {
  doc_type: 'resume' | 'driver_license' | 'ssn';
  s3_key: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string;
}

export interface WorkerProfile {
  worker_id: string;
  full_name: string | null;
  phone: string | null;
  skills: string[] | null;
  availability: string | null;
  years_experience: number | null;
  location: string | null;
  application_status: ApplicationStatus;
  applied_at: string | null;
}

export async function getWorkerProfile(
  token: string,
  workerId: string,
  jobId: string,
): Promise<WorkerProfile> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/profile?job_id=${jobId}`,
    {},
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_fetch_failed');
  return res.json();
}

export async function updateApplicantStatus(
  token: string,
  jobId: string,
  workerId: string,
  status: ApplicationStatus,
): Promise<{ status: ApplicationStatus }> {
  const res = await apiFetch(
    `/employer/jobs/${jobId}/applicants/${workerId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'status_update_failed');
  return res.json();
}

export async function getWorkerDocuments(
  token: string,
  workerId: string,
  jobId: string,
): Promise<{ documents: WorkerDocument[] }> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/documents?job_id=${jobId}`,
    {},
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'docs_fetch_failed');
  return res.json();
}

export async function createUploadToken(
  token: string,
  jobId: string,
  workerId: string,
): Promise<{ upload_url: string }> {
  const res = await apiFetch(
    '/employer/upload-tokens',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, worker_id: workerId }),
    },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'token_create_failed');
  return res.json();
}
