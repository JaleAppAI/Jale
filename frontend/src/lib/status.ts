export type JobStatus = 'active' | 'paused' | 'filled' | 'closed';
export type WritableJobStatus = 'active' | 'paused' | 'closed';

export type ApplicationStatus =
  | 'pending'
  | 'contacted'
  | 'talking'
  | 'hired'
  | 'not_interested';

export type LegacyApplicationStatus = 'reviewed' | 'rejected';

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
  if (status === 'contacted' || status === 'talking') return { bg: 'var(--jale-blue-50)', color: 'var(--jale-blue-700)', dot: 'var(--jale-blue-500)' };
  return { bg: 'var(--jale-paper-2)', color: 'var(--jale-ink-2)', dot: 'var(--jale-ink-2)' };
}
