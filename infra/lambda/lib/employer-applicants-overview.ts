import type { PoolClient } from 'pg';

export type ApplicantOverviewItem = {
  application_id: string;
  worker_id: string;
  worker_name: string | null;
  job_id: string;
  job_title: string;
  job_city: string | null;
  job_status: string;
  application_status: string;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | null;
  /** From the employer_candidate_rankings cache; null when never computed. */
  match_score: number | null;
  score_band: 'strong' | 'good' | 'fair' | null;
};

export type OverviewJob = { job_id: string; title: string; city: string | null; status: string };

export type ApplicantsOverview = {
  applicants: ApplicantOverviewItem[];
  jobs: OverviewJob[];
  total: number;
};

// One row per non-dismissed application across ALL the employer's jobs.
// The ranking cache is a LEFT JOIN on purpose: a missing score renders as
// "not scored", never blocks the row. Status vocabulary is the 091 set
// (pending|contacted|talking|details_requested|hired|not_interested) plus the
// same legacy normalization employer-job-applicants keeps ('reviewed' ->
// 'contacted'; 'rejected' rows are excluded outright) so the two surfaces
// never disagree. This overview deliberately does NOT compute the 091
// stageView/prompt answers -- that depth belongs to the per-job surface.
const OVERVIEW_QUERY = `
  SELECT
    ja.id AS application_id,
    ja.worker_id,
    COALESCE(wp.full_name, u.full_name) AS worker_name,
    j.id AS job_id,
    j.title AS job_title,
    j.city AS job_city,
    j.status AS job_status,
    CASE ja.status
      WHEN 'reviewed' THEN 'contacted'
      ELSE ja.status
    END AS application_status,
    ja.applied_at,
    ARRAY(
      SELECT ws.skill
      FROM worker_skills ws
      WHERE ws.worker_id = ja.worker_id
      ORDER BY ws.skill
    ) AS skills,
    wp.availability,
    wp.years_experience,
    ecr.score AS match_score,
    ecr.score_band
  FROM job_applications ja
  JOIN jobs j ON j.id = ja.job_id AND j.employer_id = $1
  JOIN users u ON u.id = ja.worker_id
  LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
  LEFT JOIN employer_candidate_rankings ecr
    ON ecr.job_id = ja.job_id AND ecr.worker_id = ja.worker_id
  WHERE ja.status NOT IN ('not_interested', 'rejected')
  ORDER BY ja.applied_at DESC
  LIMIT 500`;

export async function listEmployerApplicantsOverview(
  client: PoolClient,
  employerId: string,
): Promise<ApplicantsOverview> {
  const result = await client.query<ApplicantOverviewItem>(OVERVIEW_QUERY, [employerId]);

  const jobs: OverviewJob[] = [];
  const seen = new Set<string>();
  for (const item of result.rows) {
    if (seen.has(item.job_id)) continue;
    seen.add(item.job_id);
    jobs.push({ job_id: item.job_id, title: item.job_title, city: item.job_city, status: item.job_status });
  }

  return { applicants: result.rows, jobs, total: result.rows.length };
}
