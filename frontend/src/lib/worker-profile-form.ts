export type WorkerProfileField = 'full_name' | 'skills' | 'availability' | 'location';

export interface WorkerProfileFieldValues {
  full_name: string;
  skills: string[];
  availability: string;
  location: string;
}

// Mirrors the profileIsComplete() gate in worker/jobs/[id]/page.tsx — the same
// fields the backend/apply flow actually requires.
export function validateWorkerProfileFields(values: WorkerProfileFieldValues): WorkerProfileField[] {
  const missing: WorkerProfileField[] = [];
  if (!values.full_name.trim()) missing.push('full_name');
  if (values.skills.length === 0) missing.push('skills');
  if (!values.availability.trim()) missing.push('availability');
  if (!values.location.trim()) missing.push('location');
  return missing;
}
