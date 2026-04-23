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

export type Applicant = {
  application_id: string;
  worker_id: string;
  full_name: string;
  phone: string;
  status: 'pending' | 'reviewed' | 'hired' | 'rejected';
  applied_at: string;
  skills: string[];
  availability: 'immediate' | '2-weeks' | '1-month' | null;
  years_experience: number | null;
  location: string | null;
};

export type ApplicantFilters = {
  status?: string;
  skills?: string;
  availability?: string;
  min_experience?: number;
};

export async function getJobs(token: string): Promise<Job[]> {
  const res = await apiFetch('/employer/jobs', {}, token);
  if (!res.ok) throw new Error('fetch_failed');
  const data = await res.json();
  return data.jobs;
}

export async function createJob(
  token: string,
  data: { title: string; location: string; job_type: string; description?: string }
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
