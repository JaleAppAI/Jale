import type { JobStatus } from './status';

/**
 * Job statuses a worker surface may name. The API coalesces `paused` to
 * `closed` (billing auto-pause is the employer's private state), but the
 * guard is an ALLOWLIST on purpose: an unexpected or absent value renders
 * nothing rather than a raw i18n key path (there is no runtime fallback).
 */
export type WorkerVisibleJobStatus = 'closed' | 'filled';

export function visibleJobStatusBadge(status: JobStatus | undefined): WorkerVisibleJobStatus | null {
  return status === 'closed' || status === 'filled' ? status : null;
}

/**
 * Race protection only: applicants who can load a non-active job never see
 * the Apply button (they get the "Already applied" chip). This guard covers
 * a job closing while a non-applicant has an active-job page open. Absent
 * status (older payloads) counts as active.
 */
export function canApplyToJob(job: {
  already_applied: boolean;
  missing_docs: unknown[];
  status?: JobStatus;
}): boolean {
  return !job.already_applied && job.missing_docs.length === 0 && (job.status ?? 'active') === 'active';
}
