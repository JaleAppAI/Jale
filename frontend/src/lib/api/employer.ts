import { apiFetch } from '../api';
import type { ScoreBand } from '../match';
import type { ApplicationStatus, JobStatus, WritableJobStatus } from '../status';
export type { ApplicationStatus } from '../status';

export type Job = {
  id: string;
  title: string;
  location: string;
  pay: string | null;
  job_type: 'full-time' | 'part-time' | 'contract';
  status: JobStatus;
  applicant_count: number;
  hired_count: number;
  open_count: number;
  pay_min: number | null;
  pay_max: number | null;
  start_date: string | null;
  expected_duration: string | null;
  shift_schedule: string | null;
  transportation_required: boolean;
  work_authorization_required: boolean;
  language_preference: Array<'any' | 'en' | 'es'>;
  number_of_workers_needed: number;
  trade_category: 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'drywall' | 'general_labor' | 'other' | null;
  required_experience_years: number | null;
  certifications: string[];
  created_at: string;
};

export type EmployerJobDetail = Job & {
  description: string | null;
  required_docs: Array<'resume' | 'driver_license'>;
};

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

export type RankingStatus = 'deterministic' | 'llm_cached';
export type RankingVersion = 'sql-v1' | 'llm-v1';

export type EmployerCandidate = {
  application_id: string;
  worker_id: string;
  display_name: string;
  phone: string | null;
  status: string;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | string | null;
  location: string | null;
  trust_score: number | null;
  match_score: number;
  score_band: ScoreBand;
  match_reasons: string[];
};

export type EmployerCandidatesResponse = {
  ranking_status: RankingStatus;
  ranking_version: RankingVersion;
  candidates: EmployerCandidate[];
  total: number;
  computed_at: string;
};

export type EmployerConversationStatus = 'open' | 'closed';

export type EmployerConversationSummary = {
  id: string;
  job_id: string;
  job_title: string;
  worker_id: string;
  worker_name: string | null;
  status: EmployerConversationStatus;
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
  updated_at: string;
};

export type EmployerConversationDetail = EmployerConversationSummary & {
  application_id: string;
};

export type EmployerConversationMessage = {
  id: string;
  sender_type: 'employer' | 'worker' | 'system';
  direction: 'outbound' | 'inbound';
  body: string;
  status: 'queued' | 'waiting_worker_reply' | 'sent' | 'delivered' | 'failed' | 'received';
  created_at: string;
  sent_at: string | null;
};

export type EmployerConversationResponse = {
  conversation: EmployerConversationDetail;
  messages: EmployerConversationMessage[];
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
    pay_min?: number | null;
    pay_max?: number | null;
    start_date?: string | null;
    expected_duration?: string | null;
    shift_schedule?: string | null;
    transportation_required?: boolean;
    work_authorization_required?: boolean;
    language_preference?: Array<'any' | 'en' | 'es'>;
    number_of_workers_needed?: number;
    trade_category: string;
    required_experience_years?: number | null;
    certifications?: string[];
  }
): Promise<Job> {
  const res = await apiFetch('/employer/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw new Error('create_failed');
  return res.json();
}

export async function getJob(token: string, jobId: string): Promise<EmployerJobDetail> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function updateJobStatus(
  token: string,
  jobId: string,
  status: WritableJobStatus
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

export async function getJobCandidates(
  token: string,
  jobId: string,
  limit = 100,
): Promise<EmployerCandidatesResponse> {
  const params = new URLSearchParams();
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  params.set('limit', String(Math.max(1, Math.min(safeLimit, 100))));
  const res = await apiFetch(`/employer/jobs/${jobId}/candidates?${params.toString()}`, {}, token);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? 'fetch_failed') as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function getConversations(
  token: string,
): Promise<{ conversations: EmployerConversationSummary[] }> {
  const res = await apiFetch('/employer/conversations', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversations_fetch_failed');
  return res.json();
}

export async function getConversation(
  token: string,
  conversationId: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}`, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_fetch_failed');
  return res.json();
}

export async function startConversation(
  token: string,
  data: { job_id: string; worker_id: string; initial_message: string },
): Promise<EmployerConversationResponse> {
  const res = await apiFetch('/employer/conversations', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_create_failed');
  return res.json();
}

export async function sendConversationMessage(
  token: string,
  conversationId: string,
  body: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'message_send_failed');
  return res.json();
}

export async function closeConversation(
  token: string,
  conversationId: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'closed' }),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_close_failed');
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
  main_trade: string | null;
  main_trade_other: string | null;
  has_transportation: boolean | null;
  city: string | null;
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
