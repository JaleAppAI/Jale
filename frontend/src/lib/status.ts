export type JobStatus = 'active' | 'paused' | 'filled' | 'closed';
export type WritableJobStatus = 'active' | 'paused' | 'closed';

/**
 * Mirrors `APPLICATION_STATUSES` in `infra/lambda/lib/job-fields.ts` -- same
 * order, same members. `details_requested` (sprint 23, migration 091) sits
 * between `talking` and `hired`: the employer has asked the applicant for the
 * rest of their details and cannot hire until they are in.
 */
export type ApplicationStatus =
  | 'pending'
  | 'contacted'
  | 'talking'
  | 'details_requested'
  | 'hired'
  | 'not_interested';

export type LegacyApplicationStatus = 'reviewed' | 'rejected';

/**
 * How far the stage-2 "details" collection has got for one application
 * (`job_applications.details_requested_at` / `details_completed_at`, derived
 * server-side by `detailsStatusFor`). Deliberately independent of
 * `ApplicationStatus`: an employer may move a `details_requested` applicant
 * on to `talking` without resetting the stage, so the two can disagree.
 */
export type ApplicationDetailsStatus = 'not_requested' | 'requested' | 'complete';

/** Which half of the application the worker is being asked to fill. */
export type ApplicationStage = 'apply' | 'details';

/**
 * The statuses an application never leaves. Everything else counts as active
 * -- see the worker applications page's `activeCount`, and `nextStep`'s exit
 * rule in `infra/lambda/lib/application-requirements.ts`, which uses exactly
 * this pair. `details_requested` is NOT terminal.
 */
export const TERMINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] = ['hired', 'not_interested'];

export function normalizeApplicationStatus(status: ApplicationStatus | LegacyApplicationStatus): ApplicationStatus {
  if (status === 'reviewed') return 'contacted';
  if (status === 'rejected') return 'not_interested';
  return status;
}

export function jobStatusTone(status: JobStatus): { bg: string; color: string; dot: string } {
  if (status === 'active') return { bg: 'var(--jale-success-bg)', color: '#1f7a44', dot: 'var(--jale-success)' };
  if (status === 'paused') return { bg: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)', dot: 'var(--jale-blue-500)' };
  if (status === 'filled') return { bg: 'var(--jale-paper-2)', color: 'var(--jale-ink)', dot: 'var(--jale-ink)' };
  return { bg: 'var(--jale-paper-2)', color: 'var(--jale-ink-2)', dot: 'var(--jale-ink-2)' };
}

export function applicationStatusTone(status: ApplicationStatus): { bg: string; color: string; dot: string } {
  if (status === 'hired') return { bg: 'var(--jale-success-bg)', color: '#1f7a44', dot: 'var(--jale-success)' };
  if (status === 'not_interested') return { bg: 'var(--jale-danger-bg)', color: 'var(--jale-danger)', dot: 'var(--jale-danger)' };
  // Warning, not info: this is the one status that is waiting on the WORKER,
  // and the amber dot is what tells the two apart at a glance in a list.
  if (status === 'details_requested') return { bg: 'var(--jale-warning-bg)', color: 'var(--jale-warning-text)', dot: 'var(--jale-warning)' };
  if (status === 'contacted' || status === 'talking') return { bg: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)', dot: 'var(--jale-blue-500)' };
  return { bg: 'var(--jale-paper-2)', color: 'var(--jale-ink-2)', dot: 'var(--jale-ink-2)' };
}
