export interface InternalCandidate {
  workerId: string;
  jobId: string;
  score: number;
  scoreComponents: Record<string, number>;
  candidateRank: number;
  workerLatitude: number;
  workerLongitude: number;
  distanceMeters: number;
}

export interface EmployerCandidateView {
  workerId: string;
  displayName: string;
  metroArea: string;
  distanceBand: '<5mi' | '5-15mi' | '>15mi';
  skills: string[];
  scoreBand: 'strong' | 'good' | 'fair';
  fitReasons: string[];
}

export interface WorkerJobView {
  jobId: string;
  title: string;
  company: string;
  jobSiteArea: string;
  jobType: string;
  pay: string | null;
  fitReasons: string[];
}

export function toEmployerCandidateView(
  internal: InternalCandidate,
  displayName: string,
  metroArea: string,
  skills: string[],
  fitReasons: string[],
): EmployerCandidateView {
  const distanceMiles = internal.distanceMeters / 1609.34;
  return {
    workerId: internal.workerId,
    displayName,
    metroArea,
    distanceBand: distanceMiles < 5 ? '<5mi' : distanceMiles <= 15 ? '5-15mi' : '>15mi',
    skills,
    scoreBand: internal.score >= 70 ? 'strong' : internal.score >= 45 ? 'good' : 'fair',
    fitReasons,
  };
}

export function toWorkerJobView(
  job: { id: string; title: string; company: string; location: string; job_type: string; pay: string | null },
  fitReasons: string[],
): WorkerJobView {
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    jobSiteArea: job.location,
    jobType: job.job_type,
    pay: job.pay,
    fitReasons,
  };
}
